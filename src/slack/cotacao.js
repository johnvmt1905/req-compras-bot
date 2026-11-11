// Fluxo 2 — cotação: preços → agrupamento por fornecedor → revisão → pedidos no Omie.
// O estado da sessão fica em cotacaoCache (chave = ambiente|id_requisicao).

const { app, cotacaoCache, chaveCotacao, nomeUsuario, avisarUsuario } = require('./app');
const {
  MAX_ITENS_COTACAO, escapar, limitar, viewCarregando, viewAviso, lerMetadata,
  montarViewPrecos, montarViewFornecedores, montarViewDefinirFornecedor, montarViewRevisaoFinal, parsePreco,
} = require('./blocos');
const { registrarResultadoPedidos } = require('./mensagens');
const { buscarItensDaRequisicao, registrarPedidos } = require('../services/sheets');
const { buscarFornecedoresPorTexto, incluirPedidoCompra } = require('../services/omieService');
const { ambienteDoCanal } = require('../config/environment');

const TIMEOUT_BUSCA_FORNECEDOR_MS = 2500; // o ack do submit precisa sair em até 3s
const MSG_SESSAO_EXPIRADA = 'Sessão de cotação expirada — feche e clique em "Iniciar Cotação" novamente.';

// Responde a um submit cuja sessão não existe mais (restart/expiração)
async function ackSessaoExpirada(ack, view) {
  const input = view.blocks.find(b => b.type === 'input');
  if (input) {
    await ack({ response_action: 'errors', errors: { [input.block_id]: MSG_SESSAO_EXPIRADA } });
  } else {
    await ack({ response_action: 'update', view: viewAviso('Cotação', `⚠️ ${MSG_SESSAO_EXPIRADA}`) });
  }
}

const obterEstado = (view) => cotacaoCache.get(lerMetadata(view).chave);

// ── Iniciar cotação ──────────────────────────────────────────
app.action('iniciar_cotacao', async ({ ack, body, client }) => {
  await ack();
  const valor = JSON.parse(body.actions[0].value);
  const channel = valor.channel || body.channel.id;
  const ambiente = valor.ambiente || ambienteDoCanal(channel);
  const idRequisicao = valor.id_requisicao;
  console.log(`[COTAÇÃO] Iniciada para ${idRequisicao} (${ambiente}) por ${nomeUsuario(body.user)}`);

  const aberta = await client.views.open({ trigger_id: body.trigger_id, view: viewCarregando('Cotação') });
  const aviso = (texto) => client.views.update({ view_id: aberta.view.id, view: viewAviso('Cotação', texto) });

  try {
    if (!idRequisicao) throw new Error('Botão sem identificação da requisição');
    const itens = await buscarItensDaRequisicao(idRequisicao, ambiente);

    if (itens.length === 0) {
      await aviso(`Nenhum item de *${escapar(idRequisicao)}* está pendente de pedido (todos já viraram pedido ou ainda não foram revisados).`);
      return;
    }

    // Itens revisados antes da correção não tinham o código Omie gravado
    const semCodigo = itens.filter(i => !(Number(i.codigo_omie) > 0));
    if (semCodigo.length > 0) {
      await aviso(`⚠️ Estes itens estão sem código interno do Omie na planilha (coluna L) e não podem virar pedido:\n${semCodigo.map(i => `• ${escapar(i.id_item)} — ${escapar(i.descricao)}`).join('\n')}\n\nPreencha a coluna L ou revise esses itens novamente.`);
      return;
    }

    if (itens.length > MAX_ITENS_COTACAO) {
      await aviso(`⚠️ *${escapar(idRequisicao)}* tem ${itens.length} itens — excede o limite de ${MAX_ITENS_COTACAO} do modal do Slack. Divida a requisição.`);
      return;
    }

    const estado = {
      chave: chaveCotacao(ambiente, idRequisicao),
      id_requisicao: idRequisicao,
      ambiente,
      channel,
      message_ts: valor.message_ts || body.message.ts,
      itens,
      itens_pendentes: [],
      grupos: [],
      em_atribuicao: [],
    };
    cotacaoCache.set(estado.chave, estado);
    await client.views.update({ view_id: aberta.view.id, view: montarViewPrecos(estado) });
  } catch (err) {
    console.error(`[COTAÇÃO] Erro ao iniciar cotação de ${idRequisicao}:`, err.message);
    await aviso(`⚠️ Não foi possível carregar os itens: ${escapar(err.message)}`);
  }
});

// ── Modal 1: preços ──────────────────────────────────────────
app.view('modal_precos_submit', async ({ ack, view }) => {
  const estado = obterEstado(view);
  if (!estado) return ackSessaoExpirada(ack, view);

  const values = view.state.values;
  const erros = {};
  const itensComPreco = estado.itens.map(item => {
    const blockId = `preco_${item.id_item}`;
    const preco = parsePreco(values[blockId]?.valor?.value);
    if (!(preco > 0)) erros[blockId] = 'Informe um preço válido (ex: 25,90)';
    return { ...item, preco_unitario: preco };
  });

  if (Object.keys(erros).length > 0) {
    await ack({ response_action: 'errors', errors: erros });
    return;
  }

  estado.itens_pendentes = itensComPreco;
  estado.grupos = [];
  await ack({ response_action: 'update', view: montarViewFornecedores(estado) });
});

// ── Modal 2: escolher itens do próximo fornecedor ────────────
app.view('modal2_definir_fornecedor', async ({ ack, view }) => {
  const estado = obterEstado(view);
  if (!estado) return ackSessaoExpirada(ack, view);

  // Todos os itens já têm fornecedor (ex.: voltou da revisão final)
  if (estado.itens_pendentes.length === 0) {
    await ack({ response_action: 'update', view: montarViewRevisaoFinal(estado) });
    return;
  }

  const selecionados = new Set(
    Object.entries(view.state.values)
      .filter(([blockId]) => blockId.startsWith('itens_sel_'))
      .flatMap(([, campo]) => campo.selecao?.selected_options || [])
      .map(o => o.value)
  );

  if (selecionados.size === 0) {
    await ack({ response_action: 'errors', errors: { itens_sel_0: 'Selecione ao menos um item' } });
    return;
  }

  estado.em_atribuicao = estado.itens_pendentes.filter(i => selecionados.has(i.id_item));
  await ack({ response_action: 'update', view: montarViewDefinirFornecedor(estado) });
});

// ── Modal de fornecedor (novo grupo ou edição) ───────────────
async function buscarFornecedorComTimeout(texto) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_BUSCA_FORNECEDOR_MS);
  });
  try {
    return await Promise.race([buscarFornecedoresPorTexto(texto, 5), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

app.view('modal_fornecedor_submit', async ({ ack, view, body }) => {
  const estado = obterEstado(view);
  if (!estado) return ackSessaoExpirada(ack, view);

  const values = view.state.values;
  const textoBusca = (values.busca_fornecedor?.valor?.value || '').trim();
  const prazo = (values.prazo_entrega?.valor?.value || '').trim();
  const condicao = (values.condicao_pagamento?.valor?.value || '').trim();
  const obs = (values.obs_fornecedor?.valor?.value || '').trim();

  const erros = {};
  if (!textoBusca) erros.busca_fornecedor = 'Informe o nome do fornecedor';
  if (!/^\d{1,3}$/.test(prazo)) erros.prazo_entrega = 'Informe o prazo em dias (somente números)';
  if (!condicao) erros.condicao_pagamento = 'Informe a condição de pagamento';
  if (Object.keys(erros).length > 0) {
    await ack({ response_action: 'errors', errors: erros });
    return;
  }

  let resultados;
  try {
    resultados = await buscarFornecedorComTimeout(textoBusca);
  } catch (err) {
    const msg = err.message === 'timeout'
      ? 'A lista de fornecedores ainda está carregando. Tente novamente em alguns segundos.'
      : 'Erro ao consultar fornecedores no Omie. Tente novamente.';
    if (err.message !== 'timeout') console.error('[COTAÇÃO] Erro na busca de fornecedor:', err.message);
    await ack({ response_action: 'errors', errors: { busca_fornecedor: msg } });
    return;
  }

  if (resultados.length !== 1) {
    const nomes = resultados.map(f => f.nome_fantasia || f.razao_social).join(', ');
    await ack({
      response_action: 'errors',
      errors: {
        busca_fornecedor: resultados.length === 0
          ? `Nenhum fornecedor encontrado para "${limitar(textoBusca, 50)}". Tente outro nome.`
          : `${resultados.length}+ encontrados: ${limitar(nomes, 200)}. Digite o nome completo.`,
      },
    });
    return;
  }

  const [f] = resultados;
  const fornecedor = { codigo: f.codigo_cliente_omie, nome_fantasia: f.nome_fantasia || f.razao_social, razao_social: f.razao_social };
  const itens = estado.em_atribuicao;
  const ids = new Set(itens.map(i => i.id_item));

  estado.grupos.push({ fornecedor, prazo, condicao_descricao: condicao, obs, itens });
  estado.itens_pendentes = estado.itens_pendentes.filter(i => !ids.has(i.id_item));
  estado.em_atribuicao = [];
  console.log(`[COTAÇÃO] ${estado.id_requisicao}: ${fornecedor.nome_fantasia} — ${itens.length} item(ns) (por ${nomeUsuario(body.user)})`);

  await ack({
    response_action: 'update',
    view: estado.itens_pendentes.length === 0 ? montarViewRevisaoFinal(estado) : montarViewFornecedores(estado),
  });
});

// ── Ações da revisão final ───────────────────────────────────
app.action('voltar_ao_modal2', async ({ ack, body, client }) => {
  await ack();
  const estado = cotacaoCache.get(body.actions[0].value);
  await client.views.update({
    view_id: body.view.id,
    view: estado ? montarViewFornecedores(estado) : viewAviso('Cotação', `⚠️ ${MSG_SESSAO_EXPIRADA}`),
  });
});

app.action('editar_grupo_fornecedor', async ({ ack, body, client }) => {
  await ack();
  const { chave, grupo_idx } = JSON.parse(body.actions[0].value);
  const estado = cotacaoCache.get(chave);
  const grupo = estado?.grupos[grupo_idx];
  if (!grupo) {
    await client.views.update({ view_id: body.view.id, view: viewAviso('Cotação', `⚠️ ${MSG_SESSAO_EXPIRADA}`) });
    return;
  }

  // Devolve os itens do grupo para "pendentes" e reabre o formulário preenchido
  estado.grupos.splice(grupo_idx, 1);
  estado.itens_pendentes = [...estado.itens_pendentes, ...grupo.itens];
  estado.em_atribuicao = grupo.itens;
  await client.views.update({ view_id: body.view.id, view: montarViewDefinirFornecedor(estado, grupo) });
});

// ── Revisão final: cria os pedidos no Omie ───────────────────
app.view('modal_revisao_final_submit', async ({ ack, view, body, client }) => {
  const estado = obterEstado(view);
  if (!estado) return ackSessaoExpirada(ack, view);
  await ack();

  // Evita pedidos duplicados se o submit chegar duas vezes
  if (estado.processando) return;
  estado.processando = true;

  try {
    await criarPedidos(client, estado, body.user);
  } catch (err) {
    console.error(`[COTAÇÃO] Erro inesperado ao criar pedidos de ${estado.id_requisicao}:`, err.message);
    await avisarUsuario(client, estado.channel, body.user.id, `⚠️ Erro inesperado ao criar pedidos de *${escapar(estado.id_requisicao)}*: ${escapar(err.message)}`);
  } finally {
    cotacaoCache.delete(estado.chave);
  }
});

async function criarPedidos(client, estado, user) {
  const { id_requisicao: idRequisicao, grupos } = estado;
  console.log(`[COTAÇÃO] Criando ${grupos.length} pedido(s) no Omie para ${idRequisicao} por ${nomeUsuario(user)}`);

  // Sufixo por tentativa: permite refazer a cotação dos itens que falharam
  // sem colidir com o código de integração de um pedido já criado.
  const lote = Date.now().toString(36).slice(-4);
  const criados = [];
  const erros = [];

  for (const [idx, grupo] of grupos.entries()) {
    const nome = grupo.fornecedor.nome_fantasia;
    try {
      const pedido = await incluirPedidoCompra({ idRequisicao, grupo, idxGrupo: idx, lote });
      criados.push({ ...pedido, fornecedor: nome, ids: grupo.itens.map(i => i.id_item), prazo: grupo.prazo });
    } catch (err) {
      console.error(`[COTAÇÃO] Erro ao criar pedido para ${nome}:`, err.message);
      erros.push({ fornecedor: nome, erro: err.message });
    }
  }

  const concluido = erros.length === 0;

  if (criados.length > 0) {
    try {
      await registrarPedidos(
        idRequisicao,
        criados.map(p => ({ ids: p.ids, numero: p.cNumero, prazo: p.prazo })),
        concluido ? 'Pedido criado' : 'Pedido parcial',
        estado.ambiente,
      );
    } catch (err) {
      console.error('[COTAÇÃO] Erro ao registrar pedidos na planilha:', err.message);
      erros.push({ fornecedor: 'Planilha', erro: `pedidos criados no Omie, mas não registrados na planilha: ${err.message}` });
    }
  }

  const linhasCriados = criados.map(p => `• Nº *${escapar(p.cNumero)}* — ${escapar(p.fornecedor)}`);
  const linhasErros = erros.map(e => `• ${escapar(e.fornecedor)}: ${escapar(limitar(e.erro, 300))}`);
  const resumo = [
    criados.length > 0 ? `✅ *Pedidos criados no Omie:*\n${linhasCriados.join('\n')}` : null,
    erros.length > 0 ? `⚠️ *Falhas:*\n${linhasErros.join('\n')}${criados.length < grupos.length ? '\n_Clique em "Iniciar Cotação" novamente para refazer os itens que não viraram pedido._' : ''}` : null,
  ].filter(Boolean).join('\n\n');

  try {
    await registrarResultadoPedidos(client, estado, resumo, { concluido: criados.length === grupos.length });
  } catch (err) {
    console.error('[COTAÇÃO] Erro ao atualizar mensagem do Slack:', err.message);
  }
  await avisarUsuario(client, estado.channel, user.id, `*${escapar(idRequisicao)}* — ${criados.length}/${grupos.length} pedido(s) criados.\n${resumo}`);
}
