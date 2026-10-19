const Fuse = require('fuse.js');
const { normalizar } = require('./normalizer');
const omieService = require('./omieService');
const ncmService = require('./ncmService');

// Quantas opções de produto similar mostrar ao comprador no modal de revisão
const MAX_OPCOES_SIMILARES = 5;

// Abaixo desse limiar nem mostramos a opção como sugestão — produto
// claramente não relacionado não deveria nem aparecer na lista.
const SIMILARIDADE_MINIMA_PARA_SUGERIR = 30;

// Extrai tokens que contêm pelo menos um dígito — são os "códigos" reais
// do produto (ex: "6202", "2rs", "m12") que precisam bater com rigor,
// diferente do resto do texto (material, tipo) que pode ser aproximado.
function extrairCodigos(textoNormalizado) {
  return textoNormalizado.split(' ').filter(t => /\d/.test(t));
}

// Decide se dois códigos são "o mesmo produto" para fins de filtro.
// - Códigos PURAMENTE numéricos (ex: "6202") exigem igualdade EXATA.
//   Isso é o que evita o bug crítico: "6202" não pode combinar com
//   "6205" ou "62026" só por serem strings parecidas — são peças
//   diferentes, e confundir isso tem custo real de compra errada.
// - Códigos alfanuméricos (ex: "m12", "m12x1") aceitam prefixo, porque
//   nesses casos a variação geralmente é uma especificação adicional
//   da mesma família de produto, não um produto totalmente diferente.
function codigosCompativeis(a, b) {
  if (a === b) return true;
  const ehNumeroPuro = (s) => /^\d+$/.test(s);
  if (ehNumeroPuro(a) || ehNumeroPuro(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function fuseScoreParaPorcentagem(score) {
  return Math.round((1 - score) * 100);
}

// Mapeia o formato do Omie (codigo_produto, descricao, ncm) para o formato
// interno que o resto do sistema espera (codigo, descricao, ncm, unidade)
function mapearProdutoOmie(p) {
  return {
    codigo: p.codigo || p.codigo_produto_integracao || String(p.codigo_produto || ''),
    // IncluirPedCompra exige o identificador interno numérico, não o
    // código de exibição (por exemplo, "VN 1008").
    codigo_omie: p.codigo_omie || p.codigo_produto || null,
    descricao: p.descricao || '',
    ncm: (p.ncm || '').replace(/\D/g, ''),
    unidade: p.unidade || '',
  };
}

// Busca o NCM em cascata: histórico Omie primeiro, tabela local depois.
// Usado como sugestão de apoio quando o comprador decide cadastrar um produto novo.
async function resolverNcmParaItemNovo(descricaoNormalizada) {
  try {
    const viaOmie = await omieService.buscarNcmPorHistorico(descricaoNormalizada, normalizar, 0.5);
    if (viaOmie) return viaOmie;
  } catch (err) {
    console.error('[NCM] Erro ao consultar histórico Omie, seguindo para tabela local:', err.message);
  }

  const viaTabelaLocal = ncmService.sugerirNcm(descricaoNormalizada);
  if (viaTabelaLocal.ncm) return viaTabelaLocal;

  return { ncm: null, origem: null, descricaoNcm: null };
}

// Classifica um item: NUNCA confirma automaticamente. Sempre retorna
// status "aguardando_revisao" — a única variação é a lista de opções
// sugeridas (pode ter 0 a MAX_OPCOES_SIMILARES produtos candidatos).
// A decisão final é sempre do comprador, via modal no Slack.
//
// Estratégia de busca em duas camadas:
// 1) Se a descrição buscada contém algum código numérico (ex: "6202",
//    "m12"), só são candidatos os produtos cuja descrição contenha
//    EXATAMENTE algum desses códigos — evita que "6202" combine com
//    "6205" só por serem strings parecidas.
// 2) Dentro desse filtro (ou em todo o catálogo, se não houver código
//    extraível), usa o Fuse para ordenar por similaridade textual.
async function classificarItem(item, fuse, catalogoIndexado) {
  const descNorm = normalizar(item.descricao);
  const codigosBusca = extrairCodigos(descNorm);

  let baseBusca = catalogoIndexado;
  let fuseParaUsar = fuse;

  if (codigosBusca.length > 0) {
    const comCodigoCompativel = catalogoIndexado.filter(p =>
      codigosBusca.some(codigoBusca =>
        p._codigos.some(codigoProduto => codigosCompativeis(codigoBusca, codigoProduto))
      )
    );

    // Só restringe se de fato achou candidatos com código exato batendo —
    // senão mantém o catálogo todo como fallback (ex: termo sem código,
    // como "óleo hidráulico", continua buscando normalmente).
    if (comCodigoCompativel.length > 0) {
      baseBusca = comCodigoCompativel;
      fuseParaUsar = new Fuse(comCodigoCompativel, {
        keys: ['_descricaoNorm'],
        includeScore: true,
        threshold: 0.7,
        ignoreLocation: true,
        minMatchCharLength: 3,
      });
    }
  }

  const resultadosFuse = fuseParaUsar.search(descNorm, { limit: MAX_OPCOES_SIMILARES });

  const opcoes = resultadosFuse
    .map(r => ({
      produto: mapearProdutoOmie(r.item),
      similaridade: fuseScoreParaPorcentagem(r.score),
    }))
    .filter(o => o.similaridade >= SIMILARIDADE_MINIMA_PARA_SUGERIR);

  // Sugestão de NCM é só um apoio para o caso de o comprador optar por
  // cadastrar produto novo — não influencia a decisão de mostrar opções.
  const sugestaoNcm = await resolverNcmParaItemNovo(descNorm);

  return {
    ...item,
    status:         'aguardando_revisao',
    descricao_norm: descNorm,
    opcoes_similares: opcoes,
    similaridade:   opcoes[0]?.similaridade || 0,
    ncm_sugerido:   sugestaoNcm.ncm,
    ncm_origem:     sugestaoNcm.origem,
    ncm_descricao:  sugestaoNcm.descricaoNcm,
  };
}

// Processa todos os itens contra o catálogo REAL do Omie.
// Carrega o catálogo uma vez (cache de 30min dentro do omieService)
// e reaproveita o índice Fuse e o catálogo indexado para todos os itens.
async function processarItens(itens) {
  const catalogoOmie = await omieService.carregarCatalogoCompleto();
  const catalogoMapeado = catalogoOmie.map(mapearProdutoOmie);

  const catalogoIndexado = catalogoMapeado.map(p => {
    const descNorm = normalizar(p.descricao);
    return { ...p, _descricaoNorm: descNorm, _codigos: extrairCodigos(descNorm) };
  });

  const fuse = new Fuse(catalogoIndexado, {
    keys: ['_descricaoNorm'],
    includeScore: true,
    threshold: 0.7,
    ignoreLocation: true,
    minMatchCharLength: 3,
  });

  const resultados = [];
  for (const item of itens) {
    const resultado = await classificarItem(item, fuse, catalogoIndexado);
    resultados.push(resultado);
  }
  return resultados;
}

module.exports = { processarItens };
