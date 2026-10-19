const { google } = require('googleapis');
const { configuracaoAmbiente } = require('../config/environment');

function spreadsheetIdPara(ambiente) {
  const id = configuracaoAmbiente(ambiente).spreadsheetId;
  if (!id) throw new Error(`Planilha não configurada para o ambiente ${ambiente || 'producao'}`);
  return id;
}

// Formata a data atual no padrão brasileiro: dd/mm/yyyy - hh:mm
// Prefixo de apóstrofo força o Google Sheets a tratar como TEXTO puro,
// evitando que ele "reconheça" o padrão de data e reformate sozinho
// (comportamento padrão do Sheets com valueInputOption USER_ENTERED).
function formatarDataBR(data = new Date()) {
  const opcoes = {
    timeZone: process.env.TZ || 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  };
  const partes = new Intl.DateTimeFormat('pt-BR', opcoes).formatToParts(data);
  const obter = (tipo) => partes.find(p => p.type === tipo)?.value || '';
  return `'${obter('day')}/${obter('month')}/${obter('year')} - ${obter('hour')}:${obter('minute')}`;
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// Registra itens na aba Itens
// Mapeamento de colunas (A=1):
// A=ID Item, B=ID Req, C=Área, D=Solicitante, E=Data Envio, F=Desc Original,
// G=Desc Norm, H=Qtd, I=Unidade, J=Nº Tarefa/Subconj, K=Produto Omie,
// L=Código Omie, M=NCM, N=Similaridade%, O=Status, P=Aprovado por,
// Q=Data Aprovação, R=Observação, S=Cliente, T=Máquina/Subconjunto,
// U=Prazo Entrega, V=Nº Pedido Omie, W=Slack Message TS, X=Slack Channel
async function registrarItens(idRequisicao, itensProcessados, slackMessageTs, slackChannel, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const linhas = itensProcessados.map((item) => [
    item.id_item,
    idRequisicao,
    item.area,
    item.solicitante,
    formatarDataBR(),
    item.descricao,
    item.descricao_norm || '',
    item.quantidade,
    item.unidade,
    item.num_tarefa || item.subconjunto || item.maquina || item.projeto || '',
    item.produto_omie?.descricao || '',
    item.produto_omie?.codigo    || '',
    item.produto_omie?.ncm       || '',
    item.similaridade || 0,
    statusLabel(item.status),
    '', // Aprovado por (col P)
    '', // Data aprovação (col Q)
    item.observacao || '',   // col R
    item.cliente     || '',  // col S
    item.maquina || item.projeto || item.subconjunto || '', // col T
    '', // Prazo Entrega (col U — preenchido na cotação)
    '', // Nº Pedido Omie (col V — preenchido na cotação)
    slackMessageTs || '', // col W
    slackChannel   || '', // col X
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Itens!A4',
    valueInputOption: 'USER_ENTERED',
    resource: { values: linhas },
  });
}

// Registra requisição no Histórico
async function registrarHistorico(idRequisicao, area, solicitante, itensProcessados, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const confirmados = itensProcessados.filter(i => i.status === 'confirmado').length;
  const revisao     = itensProcessados.filter(i => i.status === 'aguardando_revisao').length;
  const aprovacao   = itensProcessados.filter(i => i.status === 'aguardando_aprovacao').length;
  const cadastro    = itensProcessados.filter(i => i.status === 'aguardando_cadastro').length;
  const total       = itensProcessados.length;
  const statusReq   = (revisao + aprovacao + cadastro) > 0 ? 'Em andamento' : 'Pronta para Omie';

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Histórico!A4',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        idRequisicao,
        area,
        solicitante,
        formatarDataBR(),
        total,
        confirmados,
        aprovacao,
        cadastro,
        statusReq,
        '', // Data conclusão
      ]],
    },
  });
}

// Busca os dados de cache do Slack para um item (message_ts e channel)
// Usado pelo bot.js para atualizar a mensagem original sem depender do cache em memória
async function buscarDadosSlackItem(idItem, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Itens!A:X',
  });

  const rows = res.data.values || [];
  const row = rows.find(r => r[0] === idItem);
  if (!row) return null;

  return {
    message_ts: row[22] || null, // col W (índice 22)
    channel:    row[23] || null, // col X (índice 23)
  };
}

// Atualiza status de um item na aba Itens.
// Retorna { idRequisicao, todosRevisados } para o bot.js decidir se deve
// mostrar o botão "Iniciar Cotação" na mensagem.
async function atualizarStatusItem(idItem, novoStatus, aprovadoPor, produtoOmie = null, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Itens!A:X',
  });

  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === idItem);
  if (rowIndex === -1) return { idRequisicao: null, todosRevisados: false };

  const excelRow = rowIndex + 1;
  const idRequisicao = rows[rowIndex][1];

  const data = [
    { range: `Itens!O${excelRow}`, values: [[statusLabel(novoStatus)]] },
    { range: `Itens!P${excelRow}`, values: [[aprovadoPor || '']] },
    { range: `Itens!Q${excelRow}`, values: [[formatarDataBR()]] },
  ];

  // Persiste o produto efetivamente escolhido/cadastrado. Esses campos são
  // a fonte usada mais tarde para montar os itens do pedido de compra.
  if (produtoOmie) {
    data.push(
      { range: `Itens!K${excelRow}`, values: [[produtoOmie.descricao || '']] },
      { range: `Itens!L${excelRow}`, values: [[produtoOmie.codigo_omie || '']] },
      { range: `Itens!M${excelRow}`, values: [[produtoOmie.ncm || '']] },
    );
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });

  let todosRevisados = false;
  if (idRequisicao) {
    todosRevisados = await recalcularHistorico(idRequisicao, ambiente);
  }

  return { idRequisicao, todosRevisados };
}

// Recalcula os contadores de uma requisição no Histórico com base no estado atual dos Itens.
// Retorna true se todos os itens já foram revisados (Confirmado ou Cadastrado),
// indicando que a requisição está pronta para o botão "Iniciar Cotação".
async function recalcularHistorico(idRequisicao, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const resItens = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Itens!A:O',
  });
  const itens = (resItens.data.values || []).filter(r => r[1] === idRequisicao);

  if (itens.length === 0) return false;

  const statusCol = 14; // coluna O (índice 14, 0-based)
  const confirmados = itens.filter(r => r[statusCol] === 'Confirmado').length;
  const aprovacao   = itens.filter(r => r[statusCol] === 'Aguardando aprovação').length;
  const cadastro    = itens.filter(r => r[statusCol] === 'Aguardando cadastro').length;
  const cadastrados = itens.filter(r => r[statusCol] === 'Cadastrado').length;
  const total       = itens.length;

  const pendentes = aprovacao + cadastro;
  const todosRevisados = pendentes === 0 && (confirmados + cadastrados) === total;

  // Localiza a linha do Histórico
  const resHist = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Histórico!A:J',
  });
  const histRows = resHist.data.values || [];
  const histIndex = histRows.findIndex(r => r[0] === idRequisicao);
  if (histIndex === -1) return todosRevisados;

  const excelRow = histIndex + 1;

  const data = [
    { range: `Histórico!E${excelRow}`, values: [[total]] },
    { range: `Histórico!F${excelRow}`, values: [[confirmados + cadastrados]] },
    { range: `Histórico!G${excelRow}`, values: [[aprovacao]] },
    { range: `Histórico!H${excelRow}`, values: [[cadastro]] },
    { range: `Histórico!I${excelRow}`, values: [['Em andamento']] }, // só muda para 'Pedido criado' quando o pedido Omie for gerado
  ];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: { valueInputOption: 'USER_ENTERED', data },
  });

  return todosRevisados;
}

function statusLabel(status) {
  const map = {
    aguardando_revisao:   'Aguardando revisão',
    confirmado:           'Confirmado',
    aguardando_aprovacao: 'Aguardando aprovação',
    aguardando_cadastro:  'Aguardando cadastro',
    cadastrado:           'Cadastrado',
    cancelado:            'Cancelado',
    pronto:               'Pronto',
  };
  return map[status] || status;
}

// Busca os dados de um item da planilha para reconstituir o modal
// quando o cache em memória foi perdido (restart do servidor)
async function buscarItemParaModal(idItem, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Itens!A:X',
  });

  const rows = res.data.values || [];
  const row = rows.find(r => r[0] === idItem);
  if (!row) return null;

  // Reconstrói a estrutura mínima que o modal precisa
  // Índices: A=0, B=1, C=2, D=3, F=5, H=7, I=8, J=9, S=18, T=19
  return {
    id_item:     row[0],
    area:        row[2],
    solicitante: row[3],
    descricao:   row[5],
    quantidade:  Number(row[7]) || 0,
    unidade:     row[8],
    subconjunto: row[2] === 'Subconjunto' ? row[9] : '',
    num_tarefa:  row[2] === 'AT'          ? row[9] : '',
    cliente:     row[18] || '',
    maquina:     row[19] || '',
    observacao:  row[17] || '',
    // opcoes_similares vazio — o comprador terá que buscar manualmente
    // se o cache foi perdido, mas pelo menos o modal abre
    opcoes_similares: [],
    similaridade: 0,
    ncm_sugerido: row[12] || '',
    ncm_origem:   null,
    ncm_descricao: null,
  };
}

// Atualiza as colunas W (Slack TS) e X (Slack Channel) de todos os itens
// de uma requisição — chamado após o envio da mensagem no Slack
async function atualizarSlackCacheItens(idRequisicao, messageTs, channel, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Itens!A:B',
  });

  const rows = res.data.values || [];
  const data = [];

  rows.forEach((row, idx) => {
    if (row[1] === idRequisicao) {
      const excelRow = idx + 1;
      data.push({ range: `Itens!W${excelRow}`, values: [[messageTs]] });
      data.push({ range: `Itens!X${excelRow}`, values: [[channel]] });
    }
  });

  if (data.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: { valueInputOption: 'RAW', data },
  });
}

// Busca todos os itens de uma requisição já confirmados/cadastrados,
// usado para montar o Modal 1 de cotação (preço por item)
async function buscarItensDaRequisicao(idRequisicao, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Itens!A:X',
  });

  const rows = res.data.values || [];
  const itensDaReq = rows.filter(r => r[1] === idRequisicao);

  return itensDaReq.map(row => ({
    id_item:      row[0],
    descricao:    row[5],  // Descrição Original
    quantidade:   Number(row[7]) || 0,
    unidade:      row[8],
    produto_omie: row[10] || '', // Produto Omie
    codigo_omie:  row[11] || '', // Código Omie
    status:       row[14] || '',
  }));
}

// Atualiza o status de uma requisição no Histórico — chamado após criar pedidos no Omie
async function atualizarStatusHistorico(idRequisicao, novoStatus, ambiente = 'producao') {
  const sheets = await getSheetsClient();
  const SPREADSHEET_ID = spreadsheetIdPara(ambiente);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Histórico!A:J',
  });

  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === idRequisicao);
  if (rowIndex === -1) return;

  const excelRow = rowIndex + 1;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `Histórico!I${excelRow}`, values: [[novoStatus]] },
        { range: `Histórico!J${excelRow}`, values: [[formatarDataBR()]] },
      ],
    },
  });

  console.log(`[SHEETS] Histórico atualizado: ${idRequisicao} → ${novoStatus}`);
}

module.exports = { registrarItens, registrarHistorico, atualizarStatusItem, buscarDadosSlackItem, atualizarSlackCacheItens, buscarItemParaModal, buscarItensDaRequisicao, atualizarStatusHistorico };
