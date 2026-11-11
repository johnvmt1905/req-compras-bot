// Configuração por ambiente. Produção e teste compartilham o mesmo fluxo,
// mas usam canal do Slack e planilha separados.

const AMBIENTE_PRODUCAO = 'producao';
const AMBIENTE_TESTE = 'teste';

function normalizarAmbiente(ambiente) {
  return ambiente === AMBIENTE_TESTE ? AMBIENTE_TESTE : AMBIENTE_PRODUCAO;
}

function configuracaoAmbiente(ambiente) {
  if (normalizarAmbiente(ambiente) === AMBIENTE_TESTE) {
    return {
      ambiente: AMBIENTE_TESTE,
      teste: true,
      slackChannelId: process.env.SLACK_TEST_CHANNEL_ID || 'C097RUHGU94',
      slackCompradorId: process.env.SLACK_TEST_COMPRADOR_ID || 'U096ZCV4CE7',
      spreadsheetId: process.env.SHEETS_TEST_SPREADSHEET_ID || '1SLOsS4yDgnZ1cX6zRDyBLL0Mip5hgvOD3f70Qhuh9Vg',
    };
  }

  return {
    ambiente: AMBIENTE_PRODUCAO,
    teste: false,
    slackChannelId: process.env.SLACK_CHANNEL_ID,
    slackCompradorId: process.env.SLACK_COMPRADOR_ID,
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
  };
}

// Mensagens antigas do Slack não carregam o ambiente no botão — deduz pelo
// canal onde a mensagem foi postada.
function ambienteDoCanal(channelId) {
  return channelId && channelId === configuracaoAmbiente(AMBIENTE_TESTE).slackChannelId
    ? AMBIENTE_TESTE
    : AMBIENTE_PRODUCAO;
}

const VARIAVEIS_OBRIGATORIAS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
  'SHEETS_SPREADSHEET_ID',
  'OMIE_APP_KEY',
  'OMIE_APP_SECRET',
];

// Avisa no startup sobre configuração faltando, em vez de o erro aparecer
// só no meio de uma requisição real.
function validarConfiguracao() {
  const faltando = VARIAVEIS_OBRIGATORIAS.filter(v => !process.env[v]);
  if (!process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    faltando.push('GOOGLE_CREDENTIALS_JSON ou GOOGLE_APPLICATION_CREDENTIALS');
  }
  faltando.forEach(v => console.warn(`[CONFIG] Variável de ambiente não configurada: ${v}`));
  return faltando;
}

module.exports = {
  AMBIENTE_PRODUCAO,
  AMBIENTE_TESTE,
  normalizarAmbiente,
  configuracaoAmbiente,
  ambienteDoCanal,
  validarConfiguracao,
};
