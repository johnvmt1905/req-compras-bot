const AMBIENTE_PRODUCAO = 'producao';
const AMBIENTE_TESTE = 'teste';

function normalizarAmbiente(ambiente) {
  return ambiente === AMBIENTE_TESTE ? AMBIENTE_TESTE : AMBIENTE_PRODUCAO;
}

function configuracaoAmbiente(ambiente) {
  const normalizado = normalizarAmbiente(ambiente);
  if (normalizado === AMBIENTE_TESTE) {
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

module.exports = { AMBIENTE_PRODUCAO, AMBIENTE_TESTE, normalizarAmbiente, configuracaoAmbiente };
