const { App, LogLevel, ExpressReceiver } = require('@slack/bolt');
const { TtlMap } = require('../utils/cache');

// ExpressReceiver permite que /slack/events e as rotas próprias
// (/requisicao, /health) convivam no mesmo servidor e porta.
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.WARN,
});

app.error(async (error) => {
  console.error('[SLACK] Erro não tratado em handler:', error.original?.message || error.message);
});

// ── Estado em memória ────────────────────────────────────────
// Tudo aqui é "acelerador": se o servidor reiniciar, os handlers
// reconstroem o necessário a partir da planilha / do próprio Slack.
const itensCache = new TtlMap({ ttlMs: 3 * 24 * 60 * 60 * 1000, max: 2000 }); // itens aguardando revisão
const cotacaoCache = new TtlMap({ ttlMs: 4 * 60 * 60 * 1000, max: 200 });     // sessões de cotação abertas

const chaveItem = ({ ambiente, id_requisicao, id_item }) => `${ambiente}|${id_requisicao || '?'}|${id_item}`;
const chaveCotacao = (ambiente, idRequisicao) => `${ambiente}|${idRequisicao}`;

const nomeUsuario = (user) => user?.name || user?.username || user?.id || 'desconhecido';

async function avisarUsuario(client, channel, userId, texto) {
  try {
    await client.chat.postEphemeral({ channel, user: userId, text: texto });
  } catch (err) {
    console.error('[SLACK] Falha ao enviar aviso ao usuário:', err.message);
  }
}

module.exports = {
  app,
  expressApp: receiver.app,
  itensCache,
  cotacaoCache,
  chaveItem,
  chaveCotacao,
  nomeUsuario,
  avisarUsuario,
};
