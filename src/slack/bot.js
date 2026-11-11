// Ponto de entrada do Slack: registra os handlers e expõe o que o server usa.
//   app.js       → instância do Bolt, caches em memória e helpers
//   blocos.js    → helpers de Block Kit e montagem dos modais
//   mensagens.js → envio/edição da mensagem da requisição no canal
//   revisao.js   → fluxo de revisão de itens (vincular / cadastrar produto)
//   cotacao.js   → fluxo de cotação e criação de pedidos no Omie

const { app, expressApp } = require('./app');
const { enviarMensagemRequisicao } = require('./mensagens');

require('./revisao');
require('./cotacao');

module.exports = { app, expressApp, enviarMensagemRequisicao };
