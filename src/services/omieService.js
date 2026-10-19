const crypto = require('crypto');

const OMIE_BASE_URL = 'https://app.omie.com.br/api/v1/';
const OMIE_ENDPOINTS = {
  produtos:    'geral/produtos/',
  clientes:    'geral/clientes/',
  pedidocompra: 'produtos/pedidocompra/',
  condicoes:   'produtos/formaspagcompras/',
};
const APP_KEY    = process.env.OMIE_APP_KEY;
const APP_SECRET = process.env.OMIE_APP_SECRET;

// ── Contador VN em memória ───────────────────────────────────
// O contador fica em memória durante a execução — sem escrita em disco,
// sem acionar restart do nodemon. Na inicialização do servidor, o valor
// é obtido diretamente do Omie (maior VN existente) para garantir que
// não há conflito mesmo após reinicializações.
// Valor -1 = ainda não inicializado (inicialização lazy na primeira chamada).
let contadorVN = -1;
const VN_INICIO = 8219; // fallback caso o Omie não tenha nenhum VN cadastrado

async function inicializarContadorVN() {
  if (contadorVN >= 0) return; // já inicializado

  try {
    const catalogo = await carregarCatalogoCompleto();
    const vns = catalogo
      .map(p => p.codigo || '')
      .filter(c => /^VN\s*\d{1,4}$/i.test(c.trim())) // só VN com até 4 dígitos — ignora outliers como VN 9500001
      .map(c => parseInt(c.replace(/[^0-9]/g, ''), 10))
      .filter(n => !isNaN(n));

    contadorVN = vns.length > 0 ? Math.max(...vns) : VN_INICIO;
    console.log(`[OMIE] Contador VN inicializado em: ${contadorVN}`);
  } catch (err) {
    contadorVN = VN_INICIO;
    console.warn(`[OMIE] Não foi possível inicializar contador VN pelo Omie, usando ${VN_INICIO}:`, err.message);
  }
}

async function gerarProximoCodigoVN(maxTentativas = 5) {
  await inicializarContadorVN();

  for (let i = 0; i < maxTentativas; i++) {
    contadorVN += 1;
    const codigo = `VN ${contadorVN}`;

    const existe = await verificarCodigoExiste(codigo);
    if (!existe) {
      console.log(`[OMIE] Próximo código VN gerado: ${codigo}`);
      return codigo;
    }

    console.log(`[OMIE] Código ${codigo} já existe, tentando próximo...`);
  }

  throw new Error(`Não foi possível gerar um código VN disponível após ${maxTentativas} tentativas.`);
}

// Verifica se um código de produto já existe no Omie
async function verificarCodigoExiste(codigo) {
  try {
    await chamarOmie('ConsultarProduto', { codigo });
    return true; // se não lançou erro, produto existe
  } catch (err) {
    // Omie retorna erro específico quando produto não existe
    if (err.message.includes('não encontrado') || err.message.includes('nao encontrado') || err.message.includes('PROD_NAO_ENCONTRADO')) {
      return false;
    }
    // Qualquer outro erro — assume que não existe para não travar o fluxo
    return false;
  }
}

// Cadastra um produto novo no Omie e invalida o cache de catálogo.
// Retorna { ok: true, codigo, codigo_omie, descricao } em caso de sucesso.
// Retorna { ok: false, motivo } em caso de erro de negócio esperado
// (ex: descrição duplicada) — sem lançar exceção para não derrubar o processo.
async function incluirProduto({ descricao, ncm, unidade, observacao }) {
  const codigo = await gerarProximoCodigoVN();

  const param = {
    codigo_produto_integracao: `REQ-${codigo.replace(' ', '')}`,
    codigo,
    descricao,
    unidade:      unidade || 'PC',
    ncm:          ncm     || '',
    obs_internas: observacao || 'Cadastrado via sistema de requisições GZero',
  };

  try {
    const resultado = await chamarOmie('IncluirProduto', param);
    invalidarCache();
    console.log(`[OMIE] Produto cadastrado: ${codigo} — ${descricao}`);
    return { ok: true, codigo, codigo_omie: resultado.codigo_produto, descricao };
  } catch (err) {
    const msg = err.message || '';

    // Descrição já usada por outro produto — erro de negócio, não técnico
    if (msg.includes('descrição informada já está sendo utilizada') || msg.includes('descricao')) {
      console.warn(`[OMIE] Descrição já cadastrada: "${descricao}" — produto não criado.`);
      return { ok: false, motivo: 'descricao_duplicada', descricao };
    }

    // Qualquer outro erro — loga e retorna falha sem lançar
    console.error(`[OMIE] Erro ao incluir produto "${descricao}":`, msg);
    return { ok: false, motivo: 'erro_omie', detalhe: msg };
  }
}

// Cache em memória do catálogo completo — evita repaginar a API do Omie
// em toda requisição. Atualizado sob demanda (ver invalidarCache).
// Estrutura: { produtos: [...], carregadoEm: timestamp }
let cacheProdutos = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos — catálogo não muda a cada segundo

async function chamarOmie(call, param, endpointKey = 'produtos') {
  if (!APP_KEY || !APP_SECRET) {
    throw new Error('OMIE_APP_KEY / OMIE_APP_SECRET não configurados no .env');
  }

  const url = OMIE_BASE_URL + (OMIE_ENDPOINTS[endpointKey] || OMIE_ENDPOINTS.produtos);

  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_key: APP_KEY,
      app_secret: APP_SECRET,
      call,
      param: [param],
    }),
  });

  const dados = await resposta.json();

  if (dados.faultstring) {
    // Omie retorna erro nesse formato mesmo com HTTP 200
    throw new Error(`Erro Omie [${call}]: ${dados.faultstring}`);
  }

  return dados;
}

// Busca uma página de produtos no Omie
async function listarProdutosPagina(pagina, registrosPorPagina = 500) {
  return chamarOmie('ListarProdutos', {
    pagina,
    registros_por_pagina: registrosPorPagina,
    apenas_importado_api: 'N',
    filtrar_apenas_omiepdv: 'N',
  });
}

// Busca o catálogo completo, paginando até o fim. Usa cache para não
// repetir isso toda hora — chamado uma vez e reaproveitado.
// Promise singleton: se o carregamento já estiver em andamento,
// requisições simultâneas aguardam o mesmo resultado em vez de
// fazer chamadas paralelas ao Omie (que retornaria REDUNDANT).
let carregandoPromise = null;

async function carregarCatalogoCompleto(forcarAtualizacao = false) {
  const agora = Date.now();

  if (!forcarAtualizacao && cacheProdutos && (agora - cacheProdutos.carregadoEm) < CACHE_TTL_MS) {
    return cacheProdutos.produtos;
  }

  // Se já há uma chamada em andamento, aguarda ela terminar
  if (carregandoPromise) {
    return carregandoPromise;
  }

  carregandoPromise = (async () => {
    try {
      let pagina = 1;
      let totalPaginas = 1;
      const todosProdutos = [];

      do {
        const resultado = await listarProdutosPagina(pagina);
        const lista = resultado.produto_servico_cadastro || [];
        todosProdutos.push(...lista);

        totalPaginas = resultado.total_de_paginas || 1;
        pagina += 1;
      } while (pagina <= totalPaginas);

      cacheProdutos = { produtos: todosProdutos, carregadoEm: Date.now() };
      console.log(`[OMIE] Catálogo carregado: ${todosProdutos.length} produtos.`);
      return todosProdutos;
    } finally {
      carregandoPromise = null; // libera para próxima chamada após TTL
    }
  })();

  return carregandoPromise;
}

function invalidarCache() {
  cacheProdutos = null;
  carregandoPromise = null;
}

// Busca produtos do Omie que já têm NCM cadastrado e cuja descrição é
// similar à fornecida. Usado para a primeira camada de sugestão de NCM
// (histórico Omie), antes de cair para a tabela local.
async function buscarNcmPorHistorico(descricaoNormalizada, normalizarFn, limiteSimilaridade = 0.5) {
  const catalogo = await carregarCatalogoCompleto();

  const candidatosComNcm = catalogo.filter(p => p.ncm && p.ncm.trim() !== '');
  if (candidatosComNcm.length === 0) return null;

  const palavrasBusca = descricaoNormalizada.split(' ').filter(p => p.length >= 3);
  if (palavrasBusca.length === 0) return null;

  let melhor = null;
  let melhorPontos = 0;

  candidatosComNcm.forEach(p => {
    const descNorm = normalizarFn(p.descricao || '');
    const palavrasItem = new Set(descNorm.split(' '));
    let acertos = 0;
    palavrasBusca.forEach(palavra => {
      if (palavrasItem.has(palavra)) acertos += 1;
    });
    const pontos = acertos / palavrasBusca.length;
    if (pontos > melhorPontos) {
      melhorPontos = pontos;
      melhor = p;
    }
  });

  if (!melhor || melhorPontos < limiteSimilaridade) return null;

  return {
    ncm: melhor.ncm.replace(/\D/g, ''),
    origem: 'historico_omie',
    descricaoNcm: melhor.descricao,
    similaridade: Math.round(melhorPontos * 100),
  };
}

// ── Fornecedores ──────────────────────────────────────────────
// Cache em memória dos fornecedores — mesmo padrão do catálogo de produtos
let cacheFornecedores = null;
let carregandoFornecedoresPromise = null;
const CACHE_FORNECEDORES_TTL_MS = 30 * 60 * 1000;

// Carrega todos os clientes/fornecedores do Omie (cadastro compartilhado)
// e filtra só os marcados como fornecedor pela tag.
async function carregarFornecedoresCompleto(forcarAtualizacao = false) {
  const agora = Date.now();

  if (!forcarAtualizacao && cacheFornecedores && (agora - cacheFornecedores.carregadoEm) < CACHE_FORNECEDORES_TTL_MS) {
    return cacheFornecedores.fornecedores;
  }

  if (carregandoFornecedoresPromise) {
    return carregandoFornecedoresPromise;
  }

  carregandoFornecedoresPromise = (async () => {
    try {
      let pagina = 1;
      let totalPaginas = 1;
      const todosClientes = [];

      do {
        console.log(`[OMIE] Buscando fornecedores — página ${pagina}${totalPaginas > 1 ? '/' + totalPaginas : ''}...`);
        const resultado = await chamarOmie('ListarClientes', {
          pagina,
          registros_por_pagina: 100,
          apenas_importado_api: 'N',
        }, 'clientes');
        const lista = resultado.clientes_cadastro || [];
        todosClientes.push(...lista);

        totalPaginas = resultado.total_de_paginas || 1;
        pagina += 1;
      } while (pagina <= totalPaginas);

      // Filtra só os marcados como fornecedor pela tag
      const fornecedores = todosClientes.filter(c => {
        const tags = (c.tags || []).map(t => (t.tag || '').toLowerCase());
        return tags.some(t => t.includes('fornecedor'));
      });

      cacheFornecedores = { fornecedores, carregadoEm: Date.now() };
      console.log(`[OMIE] Fornecedores carregados: ${fornecedores.length} (de ${todosClientes.length} clientes/fornecedores totais).`);
      return fornecedores;
    } catch (err) {
      console.error('[OMIE] Erro ao carregar fornecedores:', err.message);
      throw err;
    } finally {
      carregandoFornecedoresPromise = null;
    }
  })();

  return carregandoFornecedoresPromise;
}

// Busca fornecedores por texto (nome fantasia ou razão social) — usado
// no campo de busca do modal de cotação, já que a lista completa pode
// ser grande demais para mostrar de uma vez.
async function buscarFornecedoresPorTexto(texto, limite = 10) {
  const fornecedores = await carregarFornecedoresCompleto();
  const termoBusca = (texto || '').toLowerCase().trim();

  if (!termoBusca) return fornecedores.slice(0, limite);

  return fornecedores
    .filter(f => {
      const nomeFantasia = (f.nome_fantasia || '').toLowerCase();
      const razaoSocial  = (f.razao_social  || '').toLowerCase();
      return nomeFantasia.includes(termoBusca) || razaoSocial.includes(termoBusca);
    })
    .slice(0, limite);
}

// ── Condições de pagamento ───────────────────────────────────
let cacheCondicoesPagamento = null;
const CACHE_CONDICOES_TTL_MS = 30 * 60 * 1000;

async function listarCondicoesPagamento(forcarAtualizacao = false) {
  const agora = Date.now();

  if (!forcarAtualizacao && cacheCondicoesPagamento && (agora - cacheCondicoesPagamento.carregadoEm) < CACHE_CONDICOES_TTL_MS) {
    return cacheCondicoesPagamento.condicoes;
  }

  try {
    const resultado = await chamarOmie('ListarFormasPagCompras', {
      pagina: 1,
      registros_por_pagina: 100,
    }, 'condicoes');
    const condicoes = resultado.cadastros || [];
    cacheCondicoesPagamento = { condicoes, carregadoEm: agora };
    console.log(`[OMIE] Condições de pagamento carregadas: ${condicoes.length}`);
    return condicoes;
  } catch (err) {
    console.error('[OMIE] Erro ao carregar condições de pagamento:', err.message);
    return [];
  }
}

// ── Pedido de Compra ─────────────────────────────────────────
const OMIE_COD_CC      = 9964712606; // Itaú Unibanco
const OMIE_COD_CATEG   = '2.01.03';  // Compras de Matéria Prima

// Formata data para o padrão do Omie: DD/MM/YYYY
function formatarDataOmie(data) {
  const d = String(data.getDate()).padStart(2, '0');
  const m = String(data.getMonth() + 1).padStart(2, '0');
  const y = data.getFullYear();
  return `${d}/${m}/${y}`;
}

// O Omie limita cCodIntPed a 20 caracteres. Preserva IDs curtos e usa um
// sufixo determinístico para evitar colisões quando for necessário truncar.
function limitarCodigoIntegracao(original) {
  if (original.length <= 20) return original;

  const hash = crypto.createHash('sha1').update(original).digest('hex').slice(0, 6);
  return `${original.slice(0, 13)}-${hash}`;
}

function gerarCodigoIntegracaoPedido(idRequisicao, idxGrupo) {
  return limitarCodigoIntegracao(`${idRequisicao}-G${idxGrupo + 1}`);
}

// Cria um pedido de compra no Omie para um grupo de fornecedor.
// Retorna { nCodPed, cNumero } em caso de sucesso.
async function incluirPedidoCompra({ idRequisicao, grupo, idxGrupo }) {
  const { fornecedor, prazo, condicao_descricao, itens, obs } = grupo;

  // Data de previsão = hoje + prazo em dias
  const dtPrevisao = new Date();
  dtPrevisao.setDate(dtPrevisao.getDate() + (parseInt(prazo) || 0));

  // Código de integração único para o pedido
  const cCodIntPed = gerarCodigoIntegracaoPedido(idRequisicao, idxGrupo);

  const codigoFornecedor = Number(fornecedor.codigo);
  if (!Number.isFinite(codigoFornecedor) || codigoFornecedor <= 0) {
    throw new Error(`Fornecedor sem código interno válido no Omie: ${fornecedor.nome_fantasia || ''}`);
  }

  for (const item of itens) {
    const codigoProduto = Number(item.codigo_omie);
    if (!Number.isFinite(codigoProduto) || codigoProduto <= 0) {
      throw new Error(`Produto sem código interno válido no Omie: ${item.descricao || item.id_item}`);
    }
  }

  const param = {
    cabecalho_incluir: {
      cCodIntPed,
      dDtPrevisao:  formatarDataOmie(dtPrevisao),
      cCodParc:     '999',   // À vista — Fernando define a condição em texto livre,
                              // mas o Omie exige um código. 999 = à vista padrão.
      nQtdeParc:    1,
      cCodCateg:    OMIE_COD_CATEG,
      nCodFor:      codigoFornecedor,
      nCodCC:       OMIE_COD_CC,
      cObs:         obs || `Requisição ${idRequisicao} — ${condicao_descricao}`,
      cObsInt:      `Criado automaticamente via sistema de requisições GZero`,
    },
    produtos_incluir: itens.map((item, idx) => ({
      cCodIntItem: limitarCodigoIntegracao(`${cCodIntPed}-I${idx + 1}`),
      nCodProd:    Number(item.codigo_omie),
      cUnidade:    item.unidade,
      nQtde:       item.quantidade,
      nValUnit:    item.preco_unitario,
      nDesconto:   0,
      cObs:        item.descricao,
    })),
  };

  const resultado = await chamarOmie('IncluirPedCompra', param, 'pedidocompra');

  console.log(`[OMIE] Pedido criado: ${resultado.cNumero} (nCodPed: ${resultado.nCodPed}) — ${fornecedor.nome_fantasia}`);
  return { nCodPed: resultado.nCodPed, cNumero: resultado.cNumero, cCodIntPed };
}

module.exports = {
  carregarCatalogoCompleto,
  invalidarCache,
  buscarNcmPorHistorico,
  listarProdutosPagina,
  incluirProduto,
  inicializarContadorVN,
  buscarFornecedoresPorTexto,
  carregarFornecedoresCompleto,
  listarCondicoesPagamento,
  incluirPedidoCompra,
};
  