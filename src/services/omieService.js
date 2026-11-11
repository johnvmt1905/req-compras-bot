const crypto = require('crypto');
const { criarCacheAssincrono, mapearComConcorrencia, esperar } = require('../utils/cache');

const OMIE_BASE_URL = 'https://app.omie.com.br/api/v1/';
const OMIE_ENDPOINTS = {
  produtos:     'geral/produtos/',
  clientes:     'geral/clientes/',
  pedidocompra: 'produtos/pedidocompra/',
  condicoes:    'produtos/formaspagcompras/',
};

const TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 30 * 60 * 1000;     // catálogo/fornecedores mudam pouco
const CONCORRENCIA_PAGINAS = 3;          // páginas buscadas em paralelo (respeita limites do Omie)

const OMIE_COD_CC    = 9964712606;       // Itaú Unibanco
const OMIE_COD_CATEG = '2.01.03';        // Compras de Matéria Prima
const VN_INICIO      = 8219;             // fallback se o Omie não tiver nenhum VN

class OmieError extends Error {
  constructor(call, mensagem, { transitorio = false } = {}) {
    super(`Erro Omie [${call}]: ${mensagem}`);
    this.name = 'OmieError';
    this.transitorio = transitorio;
  }
}

// ── Cliente HTTP ─────────────────────────────────────────────
// `tentativas` > 1 só deve ser usado em chamadas de leitura: repetir uma
// escrita (IncluirProduto/IncluirPedCompra) poderia duplicar registros.
async function chamarOmie(call, param, endpointKey = 'produtos', { tentativas = 1 } = {}) {
  const { OMIE_APP_KEY, OMIE_APP_SECRET } = process.env;
  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) {
    throw new Error('OMIE_APP_KEY / OMIE_APP_SECRET não configurados no .env');
  }

  const url = OMIE_BASE_URL + OMIE_ENDPOINTS[endpointKey];
  const body = JSON.stringify({ app_key: OMIE_APP_KEY, app_secret: OMIE_APP_SECRET, call, param: [param] });

  for (let tentativa = 1; ; tentativa++) {
    try {
      return await requisicaoOmie(url, call, body);
    } catch (err) {
      const podeRepetir = tentativa < tentativas && (err.transitorio || err.name !== 'OmieError');
      if (!podeRepetir) throw err;
      console.warn(`[OMIE] ${call} falhou (tentativa ${tentativa}/${tentativas}): ${err.message}. Repetindo...`);
      await esperar(1000 * 2 ** (tentativa - 1));
    }
  }
}

async function requisicaoOmie(url, call, body) {
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const texto = await resposta.text();
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    // Gateway fora do ar devolve HTML — erro transitório, vale repetir
    throw new OmieError(call, `resposta inválida (HTTP ${resposta.status}): ${texto.slice(0, 200)}`, { transitorio: true });
  }

  // O Omie devolve erros de negócio com HTTP 200/500 e campo faultstring
  if (dados.faultstring) {
    const transitorio = resposta.status === 429 || /REDUNDANT|consumo redundante|bloquead/i.test(dados.faultstring);
    throw new OmieError(call, dados.faultstring, { transitorio });
  }
  if (!resposta.ok) {
    throw new OmieError(call, `HTTP ${resposta.status}`, { transitorio: resposta.status >= 500 || resposta.status === 429 });
  }
  return dados;
}

// Busca todas as páginas de uma listagem: a primeira define o total e as
// restantes são buscadas em paralelo com concorrência limitada.
async function listarTodasPaginas({ call, endpointKey, registrosPorPagina, chaveLista, paramExtra = {} }) {
  const buscarPagina = (pagina) => chamarOmie(call, {
    pagina,
    registros_por_pagina: registrosPorPagina,
    apenas_importado_api: 'N',
    ...paramExtra,
  }, endpointKey, { tentativas: 3 });

  const primeira = await buscarPagina(1);
  const totalPaginas = primeira.total_de_paginas || 1;
  const paginasRestantes = Array.from({ length: totalPaginas - 1 }, (_, i) => i + 2);
  const demais = await mapearComConcorrencia(paginasRestantes, CONCORRENCIA_PAGINAS, buscarPagina);

  return [primeira, ...demais].flatMap(r => r[chaveLista] || []);
}

// ── Catálogo de produtos ─────────────────────────────────────
const cacheCatalogo = criarCacheAssincrono(async () => {
  const produtos = await listarTodasPaginas({
    call: 'ListarProdutos',
    endpointKey: 'produtos',
    registrosPorPagina: 500,
    chaveLista: 'produto_servico_cadastro',
    paramExtra: { filtrar_apenas_omiepdv: 'N' },
  });
  console.log(`[OMIE] Catálogo carregado: ${produtos.length} produtos.`);
  return produtos;
}, CACHE_TTL_MS);

const carregarCatalogoCompleto = (forcar = false) => cacheCatalogo.obter(forcar);
const invalidarCache = () => cacheCatalogo.invalidar();

// ── Fornecedores ─────────────────────────────────────────────
// Clientes e fornecedores ficam no mesmo cadastro; filtra pela tag.
const cacheFornecedores = criarCacheAssincrono(async () => {
  const clientes = await listarTodasPaginas({
    call: 'ListarClientes',
    endpointKey: 'clientes',
    registrosPorPagina: 100,
    chaveLista: 'clientes_cadastro',
  });
  const fornecedores = clientes.filter(c =>
    (c.tags || []).some(t => (t.tag || '').toLowerCase().includes('fornecedor'))
  );
  console.log(`[OMIE] Fornecedores carregados: ${fornecedores.length} (de ${clientes.length} cadastros).`);
  return fornecedores;
}, CACHE_TTL_MS);

const carregarFornecedoresCompleto = (forcar = false) => cacheFornecedores.obter(forcar);

const textoBusca = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Busca por nome fantasia ou razão social (sem acento/caixa). Se algum
// fornecedor bate EXATAMENTE com o texto, ele é retornado sozinho — assim
// "RTE" não fica ambíguo só porque existe também "RTE Distribuidora".
async function buscarFornecedoresPorTexto(texto, limite = 10) {
  const fornecedores = await carregarFornecedoresCompleto();
  const termo = textoBusca(texto);
  if (!termo) return fornecedores.slice(0, limite);

  const nomes = (f) => [textoBusca(f.nome_fantasia), textoBusca(f.razao_social)];
  const exatos = fornecedores.filter(f => nomes(f).includes(termo));
  if (exatos.length === 1) return exatos;

  return fornecedores
    .filter(f => nomes(f).some(n => n.includes(termo)))
    .slice(0, limite);
}

// ── Condições de pagamento (reservado para mapear cCodParc no futuro) ─
const cacheCondicoes = criarCacheAssincrono(async () => {
  const resultado = await chamarOmie('ListarFormasPagCompras', { pagina: 1, registros_por_pagina: 100 }, 'condicoes', { tentativas: 2 });
  return resultado.cadastros || [];
}, CACHE_TTL_MS);

async function listarCondicoesPagamento(forcar = false) {
  try {
    return await cacheCondicoes.obter(forcar);
  } catch (err) {
    console.error('[OMIE] Erro ao carregar condições de pagamento:', err.message);
    return [];
  }
}

// ── Contador VN ──────────────────────────────────────────────
// Mantido em memória; inicializado a partir do maior "VN nnnn" do catálogo.
// A promise singleton evita que duas inicializações simultâneas
// sobrescrevam o contador depois de ele já ter sido incrementado.
let contadorVN = null;
let inicializandoVN = null;

function inicializarContadorVN() {
  if (contadorVN !== null) return Promise.resolve(contadorVN);
  if (!inicializandoVN) {
    inicializandoVN = (async () => {
      try {
        const catalogo = await carregarCatalogoCompleto();
        const vns = catalogo
          .map(p => (p.codigo || '').trim())
          .filter(c => /^VN\s*\d{1,4}$/i.test(c)) // ignora outliers como "VN 9500001"
          .map(c => parseInt(c.replace(/\D/g, ''), 10));
        contadorVN = vns.length > 0 ? Math.max(...vns) : VN_INICIO;
        console.log(`[OMIE] Contador VN inicializado em: ${contadorVN}`);
      } catch (err) {
        contadorVN = VN_INICIO;
        console.warn(`[OMIE] Não foi possível inicializar contador VN pelo Omie, usando ${VN_INICIO}:`, err.message);
      } finally {
        inicializandoVN = null;
      }
      return contadorVN;
    })();
  }
  return inicializandoVN;
}

const ehProdutoNaoEncontrado = (msg) => /n[aã]o (encontrad|cadastrad)|PROD_NAO_ENCONTRADO/i.test(msg);

async function verificarCodigoExiste(codigo) {
  try {
    await chamarOmie('ConsultarProduto', { codigo }, 'produtos', { tentativas: 2 });
    return true;
  } catch (err) {
    if (!ehProdutoNaoEncontrado(err.message)) {
      // Erro inesperado: segue como "não existe" — se o código já existir,
      // o próprio IncluirProduto recusa e o comprador é avisado.
      console.warn(`[OMIE] Não foi possível confirmar se ${codigo} existe:`, err.message);
    }
    return false;
  }
}

async function gerarProximoCodigoVN(maxTentativas = 5) {
  await inicializarContadorVN();
  for (let i = 0; i < maxTentativas; i++) {
    contadorVN += 1; // incremento síncrono: chamadas concorrentes recebem números distintos
    const codigo = `VN ${contadorVN}`;
    if (!(await verificarCodigoExiste(codigo))) return codigo;
    console.log(`[OMIE] Código ${codigo} já existe, tentando próximo...`);
  }
  throw new Error(`Não foi possível gerar um código VN disponível após ${maxTentativas} tentativas.`);
}

// Cadastra produto novo. Nunca lança: retorna { ok: true, codigo, codigo_omie, descricao, ncm, unidade }
// ou { ok: false, motivo, detalhe } para o bot avisar o comprador.
async function incluirProduto({ descricao, ncm, unidade, observacao }) {
  let codigo;
  try {
    codigo = await gerarProximoCodigoVN();
    const resultado = await chamarOmie('IncluirProduto', {
      codigo_produto_integracao: `REQ-${codigo.replace(/\s/g, '')}`,
      codigo,
      descricao,
      unidade:      unidade || 'PC',
      ncm:          ncm || '',
      obs_internas: observacao || 'Cadastrado via sistema de requisições GZero',
    });
    invalidarCache();
    console.log(`[OMIE] Produto cadastrado: ${codigo} — ${descricao}`);
    return { ok: true, codigo, codigo_omie: resultado.codigo_produto, descricao, ncm: ncm || '', unidade };
  } catch (err) {
    const msg = err.message || '';
    if (/descri[cç][aã]o.*utilizad/i.test(msg)) {
      console.warn(`[OMIE] Descrição já cadastrada: "${descricao}" — produto não criado.`);
      return { ok: false, motivo: 'descricao_duplicada', detalhe: msg };
    }
    console.error(`[OMIE] Erro ao incluir produto "${descricao}" (${codigo || 'sem código'}):`, msg);
    return { ok: false, motivo: 'erro_omie', detalhe: msg };
  }
}

// ── Pedido de compra ─────────────────────────────────────────
function formatarDataOmie(data) {
  const d = String(data.getDate()).padStart(2, '0');
  const m = String(data.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${data.getFullYear()}`;
}

// O Omie limita códigos de integração a 20 caracteres. Mantém IDs curtos e
// usa sufixo determinístico (hash) quando precisa truncar.
function limitarCodigoIntegracao(original) {
  if (original.length <= 20) return original;
  const hash = crypto.createHash('sha1').update(original).digest('hex').slice(0, 6);
  return `${original.slice(0, 13)}-${hash}`;
}

// `lote` diferencia novas tentativas da mesma requisição (ex.: refazer a
// cotação dos itens que falharam) — sem ele o Omie recusaria o cCodIntPed repetido.
function gerarCodigoIntegracaoPedido(idRequisicao, idxGrupo, lote = '') {
  return limitarCodigoIntegracao(`${idRequisicao}-${lote}G${idxGrupo + 1}`);
}

function validarCodigoInterno(valor, descricao) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new Error(`${descricao} sem código interno válido no Omie`);
  }
  return numero;
}

async function incluirPedidoCompra({ idRequisicao, grupo, idxGrupo, lote = '' }) {
  const { fornecedor, prazo, condicao_descricao, itens, obs } = grupo;

  const nCodFor = validarCodigoInterno(fornecedor.codigo, `Fornecedor "${fornecedor.nome_fantasia || ''}"`);
  const produtos = itens.map(item => ({
    item,
    nCodProd: validarCodigoInterno(item.codigo_omie, `Produto "${item.descricao || item.id_item}"`),
  }));

  const dtPrevisao = new Date();
  dtPrevisao.setDate(dtPrevisao.getDate() + (parseInt(prazo, 10) || 0));
  const cCodIntPed = gerarCodigoIntegracaoPedido(idRequisicao, idxGrupo, lote);

  const resultado = await chamarOmie('IncluirPedCompra', {
    cabecalho_incluir: {
      cCodIntPed,
      dDtPrevisao: formatarDataOmie(dtPrevisao),
      cCodParc:    '999', // o Omie exige um código; a condição real vai no texto da observação
      nQtdeParc:   1,
      cCodCateg:   OMIE_COD_CATEG,
      nCodFor,
      nCodCC:      OMIE_COD_CC,
      cObs:        obs || `Requisição ${idRequisicao} — ${condicao_descricao}`,
      cObsInt:     'Criado automaticamente via sistema de requisições GZero',
    },
    produtos_incluir: produtos.map(({ item, nCodProd }, idx) => ({
      cCodIntItem: limitarCodigoIntegracao(`${cCodIntPed}-I${idx + 1}`),
      nCodProd,
      cUnidade:    item.unidade,
      nQtde:       item.quantidade,
      nValUnit:    item.preco_unitario,
      nDesconto:   0,
      cObs:        item.descricao,
    })),
  }, 'pedidocompra');

  console.log(`[OMIE] Pedido criado: ${resultado.cNumero} (nCodPed: ${resultado.nCodPed}) — ${fornecedor.nome_fantasia}`);
  return { nCodPed: resultado.nCodPed, cNumero: resultado.cNumero, cCodIntPed };
}

module.exports = {
  chamarOmie,
  carregarCatalogoCompleto,
  invalidarCache,
  incluirProduto,
  inicializarContadorVN,
  carregarFornecedoresCompleto,
  buscarFornecedoresPorTexto,
  listarCondicoesPagamento,
  incluirPedidoCompra,
  gerarCodigoIntegracaoPedido,
  limitarCodigoIntegracao,
};
