// Envio e edição da mensagem de requisição no canal do Slack.

const { app, itensCache, chaveItem } = require('./app');
const { secao, divisor, plain, escapar, formatarItemSolicitado } = require('./blocos');
const { configuracaoAmbiente } = require('../config/environment');
const { TtlMap, criarLock } = require('../utils/cache');

// Uma mensagem do Slack aceita até 50 blocos. Cabeçalho usa 3 e o rodapé
// de cotação/resultado precisa de folga, então cada mensagem leva até 40 itens.
const ITENS_POR_MENSAGEM = 40;

const NOMES_AREA = { AT: 'Assistência Técnica', Subconjunto: 'Subconjunto', 'Reforma e Retrofit': 'Reforma e Retrofit' };

// Cache dos blocos enviados (evita conversations.history a cada edição)
const mensagensCache = new TtlMap({ ttlMs: 7 * 24 * 60 * 60 * 1000, max: 500 });
// Edições da mesma mensagem são serializadas: sem isso, dois itens revisados
// ao mesmo tempo sobrescreviam a atualização um do outro.
const comLock = criarLock();

function botaoRevisar(ctx) {
  return {
    type: 'button',
    text: plain('Revisar'),
    value: JSON.stringify({ id_item: ctx.id_item, id_requisicao: ctx.id_requisicao, ambiente: ctx.ambiente }),
    action_id: 'abrir_modal_revisao',
    style: 'primary',
  };
}

const blocoItem = (ctx, texto, comBotao = true) =>
  secao(texto, { block_id: `item_${ctx.id_item}`, ...(comBotao ? { accessory: botaoRevisar(ctx) } : {}) });

async function enviarMensagemRequisicao(idRequisicao, itens, ambiente) {
  const config = configuracaoAmbiente(ambiente);
  if (!config.slackChannelId) throw new Error(`Canal do Slack não configurado para o ambiente ${config.ambiente}`);

  const ref = itens[0] || {};
  const area = NOMES_AREA[ref.area] || 'Subconjunto';
  const destinatario = config.slackCompradorId ? `<@${config.slackCompradorId}>` : escapar(process.env.SLACK_COMPRADOR_NOME || 'Comprador');
  const cliente = ref.cliente ? `*${escapar(ref.cliente)}*` : '*cliente não informado*';
  const texto = `Nova requisição ${idRequisicao}`;

  const lotes = [];
  for (let i = 0; i < itens.length; i += ITENS_POR_MENSAGEM) lotes.push(itens.slice(i, i + ITENS_POR_MENSAGEM));

  const slackPorItem = new Map();
  for (const [n, lote] of lotes.entries()) {
    const continuacao = lotes.length > 1 ? ` (parte ${n + 1}/${lotes.length})` : '';
    const blocks = [
      { type: 'header', text: plain(`📦 Nova Requisição de Compras — ${area}${config.teste ? ' [TESTE]' : ''}`, 150) },
      secao(`${destinatario}\n*${escapar(ref.solicitante || '')}* enviou uma requisição para ${cliente}\n\`${escapar(idRequisicao)}\` · pronta para análise${continuacao}`),
      divisor(),
      ...lote.map(item => {
        const ctx = { id_item: item.id_item, id_requisicao: idRequisicao, ambiente: config.ambiente };
        itensCache.set(chaveItem(ctx), { ...item, id_requisicao: idRequisicao });
        return blocoItem(ctx, formatarItemSolicitado(item));
      }),
    ];

    const resultado = await app.client.chat.postMessage({ channel: config.slackChannelId, blocks, text: texto + continuacao });
    mensagensCache.set(resultado.ts, { blocks, text: texto + continuacao });
    lote.forEach(item => slackPorItem.set(item.id_item, { ts: resultado.ts, channel: resultado.channel }));
  }

  return slackPorItem;
}

async function obterMensagem(client, channel, ts) {
  const emCache = mensagensCache.get(ts);
  if (emCache) return emCache;

  // Fallback após restart: busca a mensagem exata pelo ts
  const historico = await client.conversations.history({ channel, latest: ts, oldest: ts, inclusive: true, limit: 1 });
  const msg = historico.messages?.find(m => m.ts === ts);
  if (!msg) throw new Error(`Mensagem ${ts} não encontrada no canal ${channel}`);
  const mensagem = { blocks: msg.blocks || [], text: msg.text || '' };
  mensagensCache.set(ts, mensagem);
  return mensagem;
}

// Aplica `transformar(blocks)` na mensagem e salva, com lock por mensagem
function editarMensagem(client, channel, ts, transformar) {
  return comLock(ts, async () => {
    const atual = await obterMensagem(client, channel, ts);
    const blocks = transformar(atual.blocks);
    await client.chat.update({ channel, ts, blocks, text: atual.text });
    mensagensCache.set(ts, { ...atual, blocks });
  });
}

// Substitui o bloco do item. `comBotao` mantém o "Revisar" (ex.: cadastro falhou)
function atualizarBlocoItem(client, ctx, texto, { comBotao = false } = {}) {
  const blockId = `item_${ctx.id_item}`;
  return editarMensagem(client, ctx.channel, ctx.message_ts, blocks =>
    blocks.map(b => (b.block_id === blockId ? blocoItem(ctx, texto, comBotao) : b))
  );
}

const BLOCOS_COTACAO = new Set(['div_cotacao', 'bloco_iniciar_cotacao']);
const semBotaoCotacao = (blocks) => blocks.filter(b => !BLOCOS_COTACAO.has(b.block_id));

// Idempotente: dois itens finalizados ao mesmo tempo não duplicam o botão
function adicionarBotaoCotacao(client, ctx) {
  return editarMensagem(client, ctx.channel, ctx.message_ts, blocks => [
    ...semBotaoCotacao(blocks),
    divisor('div_cotacao'),
    secao('✅ *Todos os itens revisados!* Pronto para iniciar a cotação.', {
      block_id: 'bloco_iniciar_cotacao',
      accessory: {
        type: 'button',
        text: plain('💰 Iniciar Cotação'),
        value: JSON.stringify({ id_requisicao: ctx.id_requisicao, ambiente: ctx.ambiente, channel: ctx.channel, message_ts: ctx.message_ts }),
        action_id: 'iniciar_cotacao',
        style: 'primary',
      },
    }),
  ]);
}

// Acrescenta o resultado da criação de pedidos. Se tudo deu certo, remove o
// botão de cotação; se houve falha, mantém para refazer os itens restantes.
function registrarResultadoPedidos(client, { channel, message_ts }, texto, { concluido }) {
  return editarMensagem(client, channel, message_ts, blocks => {
    const base = concluido ? semBotaoCotacao(blocks) : blocks;
    return [...base, divisor(), secao(texto)];
  });
}

module.exports = {
  enviarMensagemRequisicao,
  atualizarBlocoItem,
  adicionarBotaoCotacao,
  registrarResultadoPedidos,
};
