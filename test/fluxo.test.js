// Simula o fluxo completo no Slack (revisão → cotação → pedido) com Slack,
// Omie e Google Sheets substituídos por fakes em memória.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SLACK_SIGNING_SECRET = 'teste';
process.env.SLACK_BOT_TOKEN = 'xoxb-teste';
process.env.SLACK_TEST_CHANNEL_ID = 'CTESTE';

// ── Fake da API do Slack ─────────────────────────────────────
const { WebClient } = require('@slack/web-api');
const chamadasSlack = [];
WebClient.prototype.apiCall = async function apiCall(method, options = {}) {
  chamadasSlack.push({ method, options });
  if (method === 'auth.test') return { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1' };
  if (method === 'chat.postMessage') return { ok: true, ts: '111.1', channel: options.channel };
  if (method === 'views.open') return { ok: true, view: { id: 'V1' } };
  return { ok: true };
};
const ultima = (method) => [...chamadasSlack].reverse().find(c => c.method === method)?.options;

// ── Fake do Omie ─────────────────────────────────────────────
const omie = require('../src/services/omieService');
const catalogo = [
  { codigo: 'VN 1001', codigo_produto: 5001, descricao: 'Rolamento 6205 2RS', ncm: '8482.10.10', unidade: 'PC' },
  { codigo: 'VN 1002', codigo_produto: 5002, descricao: 'Rolamento 6202 2RS', ncm: '8482.10.10', unidade: 'PC' },
  { codigo: 'VN 1003', codigo_produto: 5003, descricao: 'Rolamento 6205 ZZ antigo', unidade: 'PC', inativo: 'S' },
];
const pedidosOmie = [];
omie.carregarCatalogoCompleto = async () => catalogo;
omie.incluirProduto = async (dados) => ({ ok: true, codigo: 'VN 1004', codigo_omie: 7001, descricao: dados.descricao, ncm: dados.ncm, unidade: dados.unidade });
omie.buscarFornecedoresPorTexto = async (texto) => (texto.toLowerCase() === 'cld'
  ? [{ codigo_cliente_omie: 9001, nome_fantasia: 'CLD Maquinas', razao_social: 'CLD Maquinas LTDA' }]
  : []);
omie.incluirPedidoCompra = async (args) => {
  pedidosOmie.push(args);
  return { nCodPed: 1, cNumero: '000123', cCodIntPed: 'X' };
};

// ── Fake da planilha ─────────────────────────────────────────
const sheets = require('../src/services/sheets');
const planilha = new Map();
const pedidosPlanilha = [];
sheets.registrarItens = async (idReq, itens) => itens.forEach(i => planilha.set(i.id_item, { ...i, id_requisicao: idReq }));
sheets.registrarHistorico = async () => {};
sheets.atualizarSlackCacheItens = async () => {};
sheets.buscarItemParaModal = async (idItem) => planilha.get(idItem) || null;
sheets.atualizarStatusItem = async ({ idItem, status, produto }) => {
  Object.assign(planilha.get(idItem), { status, produto });
  const todos = [...planilha.values()];
  return { idRequisicao: 'REQ-1', todosRevisados: todos.every(i => ['confirmado', 'cadastrado'].includes(i.status)) };
};
sheets.buscarItensDaRequisicao = async () => [...planilha.values()].map(i => ({
  id_item: i.id_item, descricao: i.produto.descricao, quantidade: i.quantidade, unidade: i.unidade, codigo_omie: String(i.produto.codigo_omie),
}));
sheets.registrarPedidos = async (...args) => pedidosPlanilha.push(args);

const { app, enviarMensagemRequisicao } = require('../src/slack/bot');
const { processarItens } = require('../src/services/matcher');
const { validarPayload } = require('../src/server');

const usuario = { id: 'U1', name: 'comprador' };

async function enviarEvento(body) {
  let resposta;
  await app.processEvent({ body: { team: { id: 'T1' }, api_app_id: 'A1', ...body }, ack: async (r) => { resposta = r; } });
  return resposta;
}

const clicar = (actionId, value) => enviarEvento({
  type: 'block_actions', user: usuario, trigger_id: 'TR', channel: { id: 'CTESTE' }, message: { ts: '111.1' },
  actions: [{ type: 'button', action_id: actionId, block_id: 'b', value, action_ts: '1' }],
});

const submeter = (view, values) => enviarEvento({
  type: 'view_submission', user: usuario,
  view: { ...view, id: 'V1', hash: 'h', state: { values } },
});

const txt = (v) => ({ valor: { type: 'plain_text_input', value: v } });

test('validarPayload rejeita entradas inválidas e completa a área', () => {
  assert.match(validarPayload({}).erro, /id_requisicao/);
  assert.match(validarPayload({ id_requisicao: 'R', itens_at: [] }).erro, /Nenhum item/);
  assert.match(validarPayload({ id_requisicao: 'R', itens_at: [{ id_item: 'A' }] }).erro, /descricao/);
  assert.match(validarPayload({ id_requisicao: 'R', itens_at: [{ id_item: 'A', descricao: 'x' }, { id_item: 'A', descricao: 'y' }] }).erro, /repetido/);
  const ok = validarPayload({ id_requisicao: ' R ', itens_subconjunto: [{ id_item: 'S-1', descricao: 'x' }] });
  assert.equal(ok.idRequisicao, 'R');
  assert.equal(ok.itens[0].area, 'Subconjunto');
});

test('fluxo completo: revisão, cadastro, cotação e pedido', async () => {
  // 1) Matching: "6205" nunca sugere "6202", e produto inativo é ignorado
  const itens = await processarItens([
    { id_item: 'AT-1', area: 'AT', solicitante: 'Ana', descricao: 'rolamento 6205 2rs', quantidade: 2, unidade: 'PC', num_tarefa: 'T-1' },
    { id_item: 'AT-2', area: 'AT', solicitante: 'Ana', descricao: 'abracadeira especial <inox>', quantidade: 1, unidade: 'PC', num_tarefa: 'T-1' },
  ]);
  const codigos = itens[0].opcoes_similares.map(o => o.produto.codigo_omie);
  assert.deepEqual(codigos, [5001]);
  assert.equal(itens[1].opcoes_similares.length, 0);

  await sheets.registrarItens('REQ-1', itens);
  await enviarMensagemRequisicao('REQ-1', itens, 'teste');
  const msg = ultima('chat.postMessage');
  assert.equal(msg.channel, 'CTESTE'); // ambiente de teste usa o canal de teste
  assert.ok(msg.blocks.some(b => b.text?.text.includes('&lt;inox&gt;')), 'texto do usuário escapado');
  const botao = (id) => msg.blocks.find(b => b.block_id === `item_${id}`).accessory.value;

  // 2) Revisão do AT-1: vincula produto existente
  await clicar('abrir_modal_revisao', botao('AT-1'));
  const modalRev = ultima('views.open').view;
  const radio = modalRev.blocks.find(b => b.block_id === 'escolha_produto');
  assert.equal(radio.element.options[0].value, '5001');
  let ack = await submeter(modalRev, { escolha_produto: { escolha_radio: { type: 'radio_buttons', selected_option: { value: '5001' } } } });
  assert.equal(ack, undefined);
  assert.equal(planilha.get('AT-1').produto.codigo_omie, 5001, 'código Omie gravado na confirmação');

  // 3) Revisão do AT-2: sem sugestões → cadastro (com validação de NCM)
  await clicar('abrir_modal_revisao', botao('AT-2'));
  const modalCad = ultima('views.open').view;
  const valoresCad = (ncm) => ({
    descricao_cadastro: txt('Abraçadeira inox especial'),
    ncm_cadastro: txt(ncm),
    unidade_cadastro: { valor: { type: 'static_select', selected_option: { value: 'PC' } } },
    observacao_cadastro: txt(''),
  });
  ack = await submeter(modalCad, valoresCad('123'));
  assert.equal(ack.response_action, 'errors');
  assert.ok(ack.errors.ncm_cadastro);
  await submeter(modalCad, valoresCad('7326.90.90'));
  assert.equal(planilha.get('AT-2').status, 'cadastrado');
  assert.equal(planilha.get('AT-2').produto.codigo_omie, 7001);

  // Todos revisados → botão de cotação adicionado uma única vez
  const blocosMsg = ultima('chat.update').blocks;
  assert.equal(blocosMsg.filter(b => b.block_id === 'bloco_iniciar_cotacao').length, 1);
  const valorCotacao = blocosMsg.find(b => b.block_id === 'bloco_iniciar_cotacao').accessory.value;

  // 4) Cotação: preços
  await clicar('iniciar_cotacao', valorCotacao);
  const modalPrecos = ultima('views.update').view;
  assert.equal(modalPrecos.callback_id, 'modal_precos_submit');
  ack = await submeter(modalPrecos, { 'preco_AT-1': txt('abc'), 'preco_AT-2': txt('10') });
  assert.ok(ack.errors['preco_AT-1']);
  ack = await submeter(modalPrecos, { 'preco_AT-1': txt('25,90'), 'preco_AT-2': txt('1.234,56') });
  const modal2 = ack.view;
  assert.equal(modal2.callback_id, 'modal2_definir_fornecedor');

  // 5) Agrupamento por fornecedor
  ack = await submeter(modal2, {});
  assert.ok(ack.errors.itens_sel_0);
  ack = await submeter(modal2, { itens_sel_0: { selecao: { type: 'checkboxes', selected_options: [{ value: 'AT-1' }, { value: 'AT-2' }] } } });
  const modalForn = ack.view;
  const valoresForn = (prazo) => ({ busca_fornecedor: txt('CLD'), prazo_entrega: txt(prazo), condicao_pagamento: txt('30 dias'), obs_fornecedor: txt('') });
  ack = await submeter(modalForn, valoresForn('sete'));
  assert.ok(ack.errors.prazo_entrega);
  ack = await submeter(modalForn, valoresForn('7'));
  const revisaoFinal = ack.view;
  assert.equal(revisaoFinal.callback_id, 'modal_revisao_final_submit');

  // 6) Criação do pedido
  await submeter(revisaoFinal, {});
  assert.equal(pedidosOmie.length, 1);
  const [{ grupo }] = pedidosOmie;
  assert.equal(grupo.fornecedor.codigo, 9001);
  assert.deepEqual(grupo.itens.map(i => [i.codigo_omie, i.preco_unitario]), [['5001', 25.9], ['7001', 1234.56]]);
  assert.equal(pedidosPlanilha[0][2], 'Pedido criado');
  const final = ultima('chat.update').blocks;
  assert.ok(!final.some(b => b.block_id === 'bloco_iniciar_cotacao'), 'botão de cotação removido após sucesso');
  assert.match(ultima('chat.postEphemeral').text, /000123/);

  // Sessão encerrada: novo submit não cria pedido duplicado
  await submeter(revisaoFinal, {});
  assert.equal(pedidosOmie.length, 1);
});

test('modal 2 divide mais de 10 itens em vários checkboxes', () => {
  const { montarViewFornecedores } = require('../src/slack/blocos');
  const itens = Array.from({ length: 23 }, (_, i) => ({
    id_item: `I-${i}`, descricao: 'x'.repeat(200), quantidade: 1, unidade: 'PC', preco_unitario: 1,
  }));
  const view = montarViewFornecedores({ chave: 'k', id_requisicao: 'R', itens_pendentes: itens, grupos: [] });
  const checks = view.blocks.filter(b => b.element?.type === 'checkboxes');
  assert.equal(checks.length, 3);
  checks.forEach(c => {
    assert.ok(c.element.options.length <= 10);
    c.element.options.forEach(o => assert.ok(o.text.text.length <= 75));
  });
});
