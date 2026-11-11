const Fuse = require('fuse.js');
const { normalizar } = require('./normalizer');
const omieService = require('./omieService');
const ncmService = require('./ncmService');

const MAX_OPCOES_SIMILARES = 5;            // opções mostradas no modal de revisão
const SIMILARIDADE_MINIMA_PARA_SUGERIR = 30; // abaixo disso nem aparece como sugestão
const SIMILARIDADE_MINIMA_NCM_HISTORICO = 0.5;
const OPCOES_FUSE = {
  keys: ['_descricaoNorm'],
  includeScore: true,
  threshold: 0.7,
  ignoreLocation: true,
  minMatchCharLength: 3,
};

// Tokens com pelo menos um dígito são os "códigos" reais da peça
// (ex.: "6202", "2rs", "m12") e precisam bater com rigor.
const extrairCodigos = (texto) => texto.split(' ').filter(t => /\d/.test(t));

// - Códigos puramente numéricos exigem igualdade EXATA: "6202" nunca pode
//   combinar com "6205" ou "62026" (peças diferentes = compra errada).
// - Alfanuméricos aceitam prefixo ("m12" ≈ "m12x1"): mesma família.
function codigosCompativeis(a, b) {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

// Formato interno de produto usado pelo restante do sistema.
// `codigo_omie` é o identificador numérico exigido pelo IncluirPedCompra
// (diferente do código de exibição, ex.: "VN 1008").
function mapearProdutoOmie(p) {
  return {
    codigo: p.codigo || p.codigo_produto_integracao || String(p.codigo_produto || ''),
    codigo_omie: p.codigo_omie || p.codigo_produto || null,
    descricao: p.descricao || '',
    ncm: (p.ncm || '').replace(/\D/g, ''),
    unidade: p.unidade || '',
  };
}

// ── Índice do catálogo ───────────────────────────────────────
// Normalizar milhares de descrições e montar o Fuse é o trecho mais caro
// do matching. O índice é reconstruído só quando o omieService devolve um
// catálogo novo (TTL expirado ou produto cadastrado), e não a cada requisição.
let indiceMemo = { catalogo: null, indice: null };

function construirIndice(catalogo) {
  const produtos = catalogo
    .filter(p => p.inativo !== 'S')
    .map(p => {
      const produto = mapearProdutoOmie(p);
      const descNorm = normalizar(produto.descricao);
      return { ...produto, _descricaoNorm: descNorm, _codigos: extrairCodigos(descNorm), _palavras: new Set(descNorm.split(' ')) };
    });

  return {
    produtos,
    fuse: new Fuse(produtos, OPCOES_FUSE),
    porCodigoOmie: new Map(produtos.filter(p => p.codigo_omie).map(p => [String(p.codigo_omie), p])),
    comNcm: produtos.filter(p => p.ncm),
  };
}

async function obterIndice() {
  const catalogo = await omieService.carregarCatalogoCompleto();
  if (indiceMemo.catalogo !== catalogo) {
    indiceMemo = { catalogo, indice: construirIndice(catalogo) };
  }
  return indiceMemo.indice;
}

const semCamposInternos = ({ _descricaoNorm, _codigos, _palavras, ...produto }) => produto;

// ── NCM ──────────────────────────────────────────────────────
// Cascata: produto parecido já cadastrado no Omie → tabela local da Receita.
function sugerirNcmPorHistorico(descNorm, indice) {
  const palavrasBusca = descNorm.split(' ').filter(p => p.length >= 3);
  if (!indice || palavrasBusca.length === 0) return null;

  let melhor = null;
  let melhorPontos = 0;
  for (const p of indice.comNcm) {
    const acertos = palavrasBusca.filter(palavra => p._palavras.has(palavra)).length;
    const pontos = acertos / palavrasBusca.length;
    if (pontos > melhorPontos) {
      melhorPontos = pontos;
      melhor = p;
    }
  }

  if (!melhor || melhorPontos < SIMILARIDADE_MINIMA_NCM_HISTORICO) return null;
  return { ncm: melhor.ncm, origem: 'historico_omie', descricaoNcm: melhor.descricao };
}

function sugerirNcm(descNorm, indice) {
  return sugerirNcmPorHistorico(descNorm, indice) || ncmService.sugerirNcm(descNorm);
}

// ── Classificação ────────────────────────────────────────────
// Nunca confirma automaticamente: todo item volta como "aguardando_revisao"
// com 0..MAX_OPCOES_SIMILARES sugestões. A decisão é sempre do comprador.
//
// Busca em duas camadas:
// 1) Se a descrição tem códigos (ex.: "6202"), só entram produtos com código
//    compatível — evita "6202" casar com "6205" por similaridade de texto.
// 2) Dentro desse filtro (ou no catálogo todo, se não houver código ou
//    nenhum candidato), o Fuse ordena por similaridade textual.
function buscarOpcoes(descNorm, indice) {
  if (!indice || !descNorm) return [];

  // Códigos numéricos (ex.: "6205") filtram primeiro; só sem eles os
  // alfanuméricos ("2rs") são usados — senão "6202 2RS" passaria pelo "2rs".
  const codigosBusca = extrairCodigos(descNorm);
  const numericos = codigosBusca.filter(c => /^\d+$/.test(c));
  const filtrarPor = (codigos) => indice.produtos.filter(p =>
    codigos.some(cb => p._codigos.some(cp => codigosCompativeis(cb, cp)))
  );

  let candidatos = numericos.length > 0 ? filtrarPor(numericos) : [];
  if (candidatos.length === 0 && codigosBusca.length > 0) candidatos = filtrarPor(codigosBusca);
  const fuse = candidatos.length > 0 ? new Fuse(candidatos, OPCOES_FUSE) : indice.fuse;

  return fuse.search(descNorm, { limit: MAX_OPCOES_SIMILARES })
    .map(r => ({ produto: semCamposInternos(r.item), similaridade: Math.round((1 - r.score) * 100) }))
    .filter(o => o.similaridade >= SIMILARIDADE_MINIMA_PARA_SUGERIR);
}

function classificarItem(item, indice) {
  const descNorm = normalizar(item.descricao);
  const opcoes = buscarOpcoes(descNorm, indice);
  const ncm = sugerirNcm(descNorm, indice);

  return {
    ...item,
    status:           'aguardando_revisao',
    descricao_norm:   descNorm,
    opcoes_similares: opcoes,
    similaridade:     opcoes[0]?.similaridade || 0,
    ncm_sugerido:     ncm.ncm,
    ncm_origem:       ncm.origem,
    ncm_descricao:    ncm.descricaoNcm,
    // Se o Omie estiver fora, o item segue sem sugestões e o modal tenta
    // recalcular quando o comprador abrir a revisão.
    catalogo_indisponivel: !indice,
  };
}

async function processarItens(itens) {
  let indice = null;
  try {
    indice = await obterIndice();
  } catch (err) {
    console.error('[MATCHER] Catálogo Omie indisponível — itens seguirão sem sugestões:', err.message);
  }
  return itens.map(item => classificarItem(item, indice));
}

async function buscarProdutoPorCodigoOmie(codigoOmie) {
  const indice = await obterIndice();
  const produto = indice.porCodigoOmie.get(String(codigoOmie));
  return produto ? semCamposInternos(produto) : null;
}

module.exports = { processarItens, buscarProdutoPorCodigoOmie, codigosCompativeis, extrairCodigos, mapearProdutoOmie };
