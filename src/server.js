require('dotenv').config();

// ── Handlers globais de erro ──────────────────────────────────
// Evitam que erros assíncronos não capturados derrubem o processo.
// Sem isso, qualquer promise rejeitada fora de um try/catch mata o Node,
// o nodemon reinicia e o cache de mensagens/itens do Slack se perde,
// quebrando o fluxo de aprovação.
process.on('unhandledRejection', (reason) => {
  console.error('[ERRO] Promise rejeitada não tratada:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('[ERRO] Exceção não capturada:', err.message);
});

const { app: slackApp, enviarMensagemRequisicao, expressApp } = require('./slack/bot');
const { processarItens }      = require('./services/matcher');
const { registrarItens, registrarHistorico } = require('./services/sheets');
const { inicializarContadorVN } = require('./services/omieService');
// Usamos o MESMO Express que o Bolt monta internamente (via ExpressReceiver)
// para que /slack/events e /requisicao convivam no mesmo servidor/porta
const server = expressApp;
server.use(require('express').json());

const PORT = process.env.PORT || 3000;

// ── Health check ─────────────────────────────────────────────
server.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Produção e teste compartilham o mesmo fluxo, mas usam canal/planilha
// separados. O ambiente de teste usa canal e planilha próprios e marca
// explicitamente no Omie os registros reais criados por esse fluxo.
function receberRequisicao(ambiente) {
  return async (req, res) => {
  const { id_requisicao, itens_at, itens_subconjunto, itens_reforma_retrofit, config } = req.body;

  if (!id_requisicao) {
    return res.status(400).json({ ok: false, mensagem: 'id_requisicao obrigatório' });
  }

  const todosItens = [
    ...(itens_at                || []),
    ...(itens_subconjunto       || []),
    ...(itens_reforma_retrofit  || []),
  ];

  if (todosItens.length === 0) {
    return res.status(400).json({ ok: false, mensagem: 'Nenhum item recebido' });
  }

  // Responde imediatamente — processamento é assíncrono
  res.status(202).json({
    ok: true,
    mensagem: 'Requisição recebida, processando...',
    id_requisicao,
    ambiente,
    itens_aceitos: todosItens.map(i => i.id_item),
  });

  // Processamento assíncrono
  try {
    const itensProcessados = await processarItens(todosItens);

    console.log(`[${id_requisicao}] ${itensProcessados.length} itens processados:`);
    itensProcessados.forEach(i => {
      console.log(`  → ${i.descricao} | status: ${i.status} | similaridade: ${i.similaridade}%`);
    });

    // Registra na planilha — ainda sem dados do Slack
    await registrarItens(id_requisicao, itensProcessados, '', '', ambiente);

    const area = itens_at?.length > 0
      ? 'AT'
      : itens_subconjunto?.length > 0
        ? 'Subconjunto'
        : 'Reforma e Retrofit';
    const solicitante = todosItens[0]?.solicitante || '';
    await registrarHistorico(id_requisicao, area, solicitante, itensProcessados, ambiente);

    // Envia para o Slack e captura o message_ts e channel retornados
    const slackResult = await enviarMensagemRequisicao(id_requisicao, itensProcessados, ambiente);

    // Atualiza as colunas W e X de cada item com os dados do Slack
    if (slackResult?.ts && slackResult?.channel) {
      const { atualizarSlackCacheItens } = require('./services/sheets');
      await atualizarSlackCacheItens(id_requisicao, slackResult.ts, slackResult.channel, ambiente);
    }

    console.log(`[${id_requisicao}] Mensagem enviada ao Slack com sucesso.`);

  } catch (err) {
    console.error(`[${id_requisicao}] Erro no processamento assíncrono:`, err.message);
    console.error(`[${id_requisicao}] Stack:`, err.stack);
  }
  };
}

server.post('/requisicao', receberRequisicao('producao'));
server.post('/requisicao-teste', receberRequisicao('teste'));

// ── Inicia servidor único (Slack + nossas rotas) ──────────────
(async () => {
  await slackApp.start(PORT);
  console.log('⚡ Slack Bolt iniciado');
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Endpoint: POST http://localhost:${PORT}/requisicao`);
  console.log(`   Teste: POST http://localhost:${PORT}/requisicao-teste`);
  console.log(`   Slack events: POST http://localhost:${PORT}/slack/events`);

  // Inicializa o contador VN em background — não bloqueia o startup
  inicializarContadorVN().catch(err =>
    console.warn('[OMIE] Inicialização do contador VN falhou (tentará novamente no primeiro cadastro):', err.message)
  );
})();
