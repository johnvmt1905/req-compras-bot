const { sheets: criarSheets, auth } = require('@googleapis/sheets');
const { configuracaoAmbiente } = require('../config/environment');

// ── Layout da aba Itens (A=0) ────────────────────────────────
const COL = {
  ID_ITEM: 0, ID_REQ: 1, AREA: 2, SOLICITANTE: 3, DATA_ENVIO: 4, DESCRICAO: 5,
  DESCRICAO_NORM: 6, QUANTIDADE: 7, UNIDADE: 8, REFERENCIA: 9, PRODUTO_OMIE: 10,
  CODIGO_OMIE: 11, NCM: 12, SIMILARIDADE: 13, STATUS: 14, APROVADO_POR: 15,
  DATA_APROVACAO: 16, OBSERVACAO: 17, CLIENTE: 18, MAQUINA: 19, PRAZO: 20,
  PEDIDO_OMIE: 21, SLACK_TS: 22, SLACK_CHANNEL: 23,
};
// Histórico: A=ID Req, B=Área, C=Solicitante, D=Data, E=Total, F=Confirmados,
// G=Aguard. aprovação, H=Aguard. cadastro, I=Status, J=Data conclusão
const RANGE_ITENS = 'Itens!A:X';
const RANGE_HISTORICO = 'Histórico!A:J';

const STATUS_LABEL = {
  aguardando_revisao:   'Aguardando revisão',
  confirmado:           'Confirmado',
  aguardando_aprovacao: 'Aguardando aprovação',
  aguardando_cadastro:  'Aguardando cadastro',
  cadastrado:           'Cadastrado',
  cancelado:            'Cancelado',
  pronto:               'Pronto',
};
const statusLabel = (status) => STATUS_LABEL[status] || status;
const STATUS_REVISADOS = new Set([STATUS_LABEL.confirmado, STATUS_LABEL.cadastrado]);

const letraColuna = (idx) => String.fromCharCode(65 + idx); // até Z, suficiente aqui

// Prefixo de apóstrofo força texto puro — sem ele o Sheets "reconhece" a
// data e reformata sozinho (valueInputOption USER_ENTERED).
function formatarDataBR(data = new Date()) {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: process.env.TZ || 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).formatToParts(data);
  const obter = (tipo) => partes.find(p => p.type === tipo)?.value || '';
  return `'${obter('day')}/${obter('month')}/${obter('year')} - ${obter('hour')}:${obter('minute')}`;
}

// ── Cliente (criado uma única vez por processo) ──────────────
// Antes o GoogleAuth era recriado a cada chamada, refazendo a troca de
// token toda hora. Credenciais: GOOGLE_CREDENTIALS_JSON (conteúdo, p/ produção)
// ou GOOGLE_APPLICATION_CREDENTIALS (caminho do arquivo, p/ desenvolvimento).
let clientePromise = null;

function obterCliente() {
  if (!clientePromise) {
    const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
    const config = process.env.GOOGLE_CREDENTIALS_JSON
      ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON), scopes }
      : { keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes };
    clientePromise = new auth.GoogleAuth(config).getClient()
      .then(authClient => criarSheets({ version: 'v4', auth: authClient }))
      .catch(err => {
        clientePromise = null; // permite nova tentativa na próxima chamada
        throw err;
      });
  }
  return clientePromise;
}

function spreadsheetIdPara(ambiente) {
  const id = configuracaoAmbiente(ambiente).spreadsheetId;
  if (!id) throw new Error(`Planilha não configurada para o ambiente ${ambiente || 'producao'}`);
  return id;
}

async function lerRange(ambiente, range) {
  const sheets = await obterCliente();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetIdPara(ambiente), range });
  return res.data.values || [];
}

async function escrever(ambiente, data, valueInputOption = 'USER_ENTERED') {
  if (data.length === 0) return;
  const sheets = await obterCliente();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetIdPara(ambiente),
    requestBody: { valueInputOption, data },
  });
}

async function anexar(ambiente, range, values) {
  const sheets = await obterCliente();
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetIdPara(ambiente),
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

const celula = (aba, colIdx, linhaIdx, valor) => ({
  range: `${aba}!${letraColuna(colIdx)}${linhaIdx + 1}`,
  values: [[valor]],
});

// O id_item (ex.: "AT-4") pode se repetir entre requisições, então a busca
// usa id_item + id_requisicao. Sem id_requisicao (mensagens antigas do
// Slack), usa a ocorrência mais recente do id_item.
function localizarLinhaItem(rows, idItem, idRequisicao) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][COL.ID_ITEM] === idItem && (!idRequisicao || rows[i][COL.ID_REQ] === idRequisicao)) return i;
  }
  return -1;
}

const referenciaItem = (item) => item.num_tarefa || item.subconjunto || item.maquina || item.projeto || '';

// ── Escrita inicial ──────────────────────────────────────────
async function registrarItens(idRequisicao, itens, ambiente) {
  const agora = formatarDataBR();
  const linhas = itens.map(item => {
    const linha = new Array(24).fill('');
    linha[COL.ID_ITEM]        = item.id_item;
    linha[COL.ID_REQ]         = idRequisicao;
    linha[COL.AREA]           = item.area || '';
    linha[COL.SOLICITANTE]    = item.solicitante || '';
    linha[COL.DATA_ENVIO]     = agora;
    linha[COL.DESCRICAO]      = item.descricao;
    linha[COL.DESCRICAO_NORM] = item.descricao_norm || '';
    linha[COL.QUANTIDADE]     = item.quantidade;
    linha[COL.UNIDADE]        = item.unidade || '';
    linha[COL.REFERENCIA]     = referenciaItem(item);
    linha[COL.SIMILARIDADE]   = item.similaridade || 0;
    linha[COL.STATUS]         = statusLabel(item.status);
    linha[COL.OBSERVACAO]     = item.observacao || '';
    linha[COL.CLIENTE]        = item.cliente || '';
    linha[COL.MAQUINA]        = item.maquina || item.projeto || item.subconjunto || '';
    return linha;
  });
  await anexar(ambiente, 'Itens!A4', linhas);
}

async function registrarHistorico(idRequisicao, area, solicitante, itens, ambiente) {
  const contar = (status) => itens.filter(i => i.status === status).length;
  const pendentes = ['aguardando_revisao', 'aguardando_aprovacao', 'aguardando_cadastro'].some(s => contar(s) > 0);
  await anexar(ambiente, 'Histórico!A4', [[
    idRequisicao, area, solicitante, formatarDataBR(), itens.length,
    contar('confirmado'), contar('aguardando_aprovacao'), contar('aguardando_cadastro'),
    pendentes ? 'Em andamento' : 'Pronta para Omie', '',
  ]]);
}

// Grava message_ts/channel (colunas W/X) — permite atualizar a mensagem do
// Slack mesmo depois de um restart. `slackPorItem`: Map id_item → { ts, channel }.
async function atualizarSlackCacheItens(idRequisicao, slackPorItem, ambiente) {
  const rows = await lerRange(ambiente, 'Itens!A:B');
  const data = [];
  rows.forEach((row, idx) => {
    const slack = row[COL.ID_REQ] === idRequisicao && slackPorItem.get(row[COL.ID_ITEM]);
    if (slack) {
      data.push(celula('Itens', COL.SLACK_TS, idx, slack.ts), celula('Itens', COL.SLACK_CHANNEL, idx, slack.channel));
    }
  });
  await escrever(ambiente, data, 'RAW');
}

// ── Revisão ──────────────────────────────────────────────────
// Atualiza status (e produto escolhido/cadastrado) de um item e recalcula o
// Histórico reaproveitando a mesma leitura da aba Itens.
// Retorna { idRequisicao, todosRevisados }.
async function atualizarStatusItem({ idItem, idRequisicao, status, usuario, produto = null, ambiente }) {
  const rows = await lerRange(ambiente, RANGE_ITENS);
  const idx = localizarLinhaItem(rows, idItem, idRequisicao);
  if (idx === -1) {
    throw new Error(`Item ${idItem} (${idRequisicao || 'requisição desconhecida'}) não encontrado na planilha`);
  }

  const idReq = rows[idx][COL.ID_REQ];
  const label = statusLabel(status);
  const data = [
    celula('Itens', COL.STATUS, idx, label),
    celula('Itens', COL.APROVADO_POR, idx, usuario || ''),
    celula('Itens', COL.DATA_APROVACAO, idx, formatarDataBR()),
  ];
  // O produto gravado aqui é a fonte usada depois para montar o pedido de compra
  if (produto) {
    data.push(
      celula('Itens', COL.PRODUTO_OMIE, idx, produto.descricao || ''),
      celula('Itens', COL.CODIGO_OMIE, idx, produto.codigo_omie ? String(produto.codigo_omie) : ''),
      celula('Itens', COL.NCM, idx, produto.ncm || ''),
    );
  }

  rows[idx][COL.STATUS] = label; // reflete a alteração para o recálculo abaixo
  const itensReq = rows.filter(r => r[COL.ID_REQ] === idReq);
  const contar = (s) => itensReq.filter(r => r[COL.STATUS] === statusLabel(s)).length;
  const todosRevisados = itensReq.every(r => STATUS_REVISADOS.has(r[COL.STATUS]));

  const hist = await lerRange(ambiente, RANGE_HISTORICO);
  const hIdx = hist.findIndex(r => r[0] === idReq);
  if (hIdx !== -1) {
    data.push(
      celula('Histórico', 4, hIdx, itensReq.length),
      celula('Histórico', 5, hIdx, contar('confirmado') + contar('cadastrado')),
      celula('Histórico', 6, hIdx, contar('aguardando_aprovacao')),
      celula('Histórico', 7, hIdx, contar('aguardando_cadastro')),
      celula('Histórico', 8, hIdx, 'Em andamento'), // vira "Pedido criado" só quando o pedido Omie é gerado
    );
  }

  await escrever(ambiente, data);
  return { idRequisicao: idReq, todosRevisados };
}

// Reconstrói o item a partir da planilha quando o cache em memória foi
// perdido (restart). As opções similares são recalculadas pelo bot.
async function buscarItemParaModal(idItem, idRequisicao, ambiente) {
  const rows = await lerRange(ambiente, RANGE_ITENS);
  const idx = localizarLinhaItem(rows, idItem, idRequisicao);
  if (idx === -1) return null;
  const row = rows[idx];
  const area = row[COL.AREA];
  return {
    id_item:       row[COL.ID_ITEM],
    id_requisicao: row[COL.ID_REQ],
    area,
    solicitante:   row[COL.SOLICITANTE],
    descricao:     row[COL.DESCRICAO],
    quantidade:    Number(row[COL.QUANTIDADE]) || 0,
    unidade:       row[COL.UNIDADE],
    subconjunto:   area === 'Subconjunto' ? row[COL.REFERENCIA] : '',
    num_tarefa:    area === 'AT' ? row[COL.REFERENCIA] : '',
    maquina:       row[COL.MAQUINA] || '',
    cliente:       row[COL.CLIENTE] || '',
    observacao:    row[COL.OBSERVACAO] || '',
    status:        row[COL.STATUS] || '',
  };
}

// ── Cotação ──────────────────────────────────────────────────
// Itens revisados da requisição que ainda não viraram pedido no Omie.
async function buscarItensDaRequisicao(idRequisicao, ambiente) {
  const rows = await lerRange(ambiente, RANGE_ITENS);
  return rows
    .filter(r => r[COL.ID_REQ] === idRequisicao && STATUS_REVISADOS.has(r[COL.STATUS]) && !r[COL.PEDIDO_OMIE])
    .map(row => ({
      id_item:      row[COL.ID_ITEM],
      descricao:    row[COL.PRODUTO_OMIE] || row[COL.DESCRICAO],
      quantidade:   Number(row[COL.QUANTIDADE]) || 0,
      unidade:      row[COL.UNIDADE],
      codigo_omie:  row[COL.CODIGO_OMIE] || '',
      status:       row[COL.STATUS],
    }));
}

// Grava prazo (U) e nº do pedido (V) em cada item e atualiza o Histórico.
// `pedidos`: [{ ids: [id_item], numero, prazo }]
async function registrarPedidos(idRequisicao, pedidos, statusHistorico, ambiente) {
  const [rows, hist] = await Promise.all([lerRange(ambiente, RANGE_ITENS), lerRange(ambiente, RANGE_HISTORICO)]);
  const data = [];

  for (const pedido of pedidos) {
    for (const idItem of pedido.ids) {
      const idx = localizarLinhaItem(rows, idItem, idRequisicao);
      if (idx === -1) continue;
      data.push(
        celula('Itens', COL.PRAZO, idx, `${pedido.prazo} dias`),
        celula('Itens', COL.PEDIDO_OMIE, idx, String(pedido.numero)),
      );
    }
  }

  const hIdx = hist.findIndex(r => r[0] === idRequisicao);
  if (hIdx !== -1) {
    data.push(celula('Histórico', 8, hIdx, statusHistorico), celula('Histórico', 9, hIdx, formatarDataBR()));
  }

  await escrever(ambiente, data);
  console.log(`[SHEETS] Pedidos registrados: ${idRequisicao} → ${statusHistorico}`);
}

module.exports = {
  registrarItens,
  registrarHistorico,
  atualizarSlackCacheItens,
  atualizarStatusItem,
  buscarItemParaModal,
  buscarItensDaRequisicao,
  registrarPedidos,
  statusLabel,
  localizarLinhaItem,
  formatarDataBR,
};
