require('dotenv').config();

const express = require('express');
const { validarConfiguracao, configuracaoAmbiente, AMBIENTE_PRODUCAO, AMBIENTE_TESTE } = require('./config/environment');
const { app: slackApp, expressApp, enviarMensagemRequisicao } = require('./slack/bot');
const { processarItens } = require('./services/matcher');
const { registrarItens, registrarHistorico, atualizarSlackCacheItens } = require('./services/sheets');
const { inicializarContadorVN, carregarFornecedoresCompleto } = require('./services/omieService');
const { carregarTabela: carregarTabelaNcm } = require('./services/ncmService');
const { TtlMap } = require('./utils/cache');

// Erros assíncronos não capturados não derrubam o processo: um restart
// perderia as sessões de cotação abertas. Ficam registrados no log.
process.on('unhandledRejection', (reason) => {
  console.error('[ERRO] Promise rejeitada não tratada:', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[ERRO] Exceção não capturada:', err.stack || err.message);
});

const PORT = Number(process.env.PORT) || 3000;
const server = expressApp; // mesmo Express do Bolt: /slack/events + rotas abaixo
server.use(express.json({ limit: '1mb' }));

// Evita processar duas vezes a mesma requisição (reenvio do Apps Script)
const requisicoesRecentes = new TtlMap({ ttlMs: 10 * 60 * 1000, max: 1000 });

server.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Token opcional: se REQUISICAO_TOKEN estiver definido, o Apps Script
// precisa enviar o mesmo valor no header "x-requisicao-token".
function autenticar(req, res, next) {
  const esperado = process.env.REQUISICAO_TOKEN;
  if (esperado && req.get('x-requisicao-token') !== esperado) {
    return res.status(401).json({ ok: false, mensagem: 'Token inválido' });
  }
  return next();
}

function validarPayload(body) {
  const { id_requisicao, itens_at, itens_subconjunto, itens_reforma_retrofit } = body || {};
  if (!id_requisicao || typeof id_requisicao !== 'string') return { erro: 'id_requisicao obrigatório' };

  // A área vem da lista de origem quando o item não a informa
  const listas = [[itens_at, 'AT'], [itens_subconjunto, 'Subconjunto'], [itens_reforma_retrofit, 'Reforma e Retrofit']];
  const itens = listas.flatMap(([lista, area]) =>
    (Array.isArray(lista) ? lista : []).map(i => (i && typeof i === 'object' ? { ...i, area: i.area || area } : i))
  );
  if (itens.length === 0) return { erro: 'Nenhum item recebido' };

  const invalidos = itens.filter(i => !i?.id_item || !String(i.descricao || '').trim());
  if (invalidos.length > 0) return { erro: `${invalidos.length} item(ns) sem id_item ou descricao` };

  const ids = itens.map(i => String(i.id_item));
  if (new Set(ids).size !== ids.length) return { erro: 'id_item repetido na mesma requisição' };

  return { idRequisicao: id_requisicao.trim(), itens };
}

async function processarRequisicao(idRequisicao, itens, ambiente) {
  const itensProcessados = await processarItens(itens);
  console.log(`[${idRequisicao}] ${itensProcessados.length} itens processados (${ambiente}):`);
  itensProcessados.forEach(i => console.log(`  → ${i.descricao} | ${i.opcoes_similares.length} sugestões | top ${i.similaridade}%`));

  // Planilha primeiro: garante o registro mesmo que o Slack falhe
  await registrarItens(idRequisicao, itensProcessados, ambiente);
  await registrarHistorico(idRequisicao, itensProcessados[0].area || '', itensProcessados[0].solicitante || '', itensProcessados, ambiente);

  const slackPorItem = await enviarMensagemRequisicao(idRequisicao, itensProcessados, ambiente);
  await atualizarSlackCacheItens(idRequisicao, slackPorItem, ambiente);
  console.log(`[${idRequisicao}] Mensagem enviada ao Slack com sucesso.`);
}

// Avisa no canal quando o processamento em background falha — antes o erro
// ficava só no log e a requisição "sumia" para o comprador.
async function notificarFalha(idRequisicao, ambiente, err) {
  try {
    await slackApp.client.chat.postMessage({
      channel: configuracaoAmbiente(ambiente).slackChannelId,
      text: `⚠️ Falha ao processar a requisição \`${idRequisicao}\`: ${err.message}. Verifique a planilha e reenvie se necessário.`,
    });
  } catch (slackErr) {
    console.error(`[${idRequisicao}] Também não foi possível avisar no Slack:`, slackErr.message);
  }
}

function receberRequisicao(ambiente) {
  return (req, res) => {
    const { erro, idRequisicao, itens } = validarPayload(req.body);
    if (erro) return res.status(400).json({ ok: false, mensagem: erro });

    const chave = `${ambiente}|${idRequisicao}`;
    if (requisicoesRecentes.has(chave)) {
      return res.status(409).json({ ok: false, mensagem: 'Requisição já recebida recentemente', id_requisicao: idRequisicao });
    }
    requisicoesRecentes.set(chave, true);

    // Responde já (202); o processamento continua em background
    res.status(202).json({
      ok: true,
      mensagem: 'Requisição recebida, processando...',
      id_requisicao: idRequisicao,
      ambiente,
      itens_aceitos: itens.map(i => i.id_item),
    });

    processarRequisicao(idRequisicao, itens, ambiente).catch(async (err) => {
      console.error(`[${idRequisicao}] Erro no processamento:`, err.stack || err.message);
      requisicoesRecentes.delete(chave); // permite reenvio após falha
      await notificarFalha(idRequisicao, ambiente, err);
    });
  };
}

server.post('/requisicao', autenticar, receberRequisicao(AMBIENTE_PRODUCAO));
server.post('/requisicao-teste', autenticar, receberRequisicao(AMBIENTE_TESTE));

// Pré-aquece caches em background para a primeira requisição não esperar
function preCarregar() {
  inicializarContadorVN(); // carrega o catálogo do Omie junto
  carregarFornecedoresCompleto().catch(err => console.warn('[OMIE] Pré-carga de fornecedores falhou:', err.message));
  setImmediate(() => {
    try {
      carregarTabelaNcm();
    } catch (err) {
      console.warn('[NCM] Pré-carga da tabela falhou:', err.message);
    }
  });
}

if (require.main === module) {
  validarConfiguracao();
  slackApp.start(PORT)
    .then(() => {
      console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
      console.log('   GET  /health | POST /requisicao | POST /requisicao-teste | POST /slack/events');
      preCarregar();
    })
    .catch(err => {
      console.error('[ERRO] Falha ao iniciar o servidor:', err.message);
      process.exit(1);
    });
}

module.exports = { server, validarPayload };
