const { App, LogLevel, ExpressReceiver } = require('@slack/bolt');
const { atualizarStatusItem, buscarDadosSlackItem, buscarItemParaModal, buscarItensDaRequisicao } = require('../services/sheets');
const { incluirProduto, buscarFornecedoresPorTexto, listarCondicoesPagamento, carregarFornecedoresCompleto, incluirPedidoCompra } = require('../services/omieService');

// ExpressReceiver permite compartilhar o mesmo servidor Express
// entre as rotas do Slack (/slack/events) e nossas rotas (/requisicao)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token:    process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
  logLevel: LogLevel.WARN,
});

const expressApp = receiver.app;

// Cache em memória das mensagens enviadas — evita precisar do scope
// conversations.history só para reconstituir os blocos na hora de atualizar.
// Indexado por message_ts.
const mensagensCache = new Map();

// Cache local de condições de pagamento — pré-carregado no startup
// para que o views.push não espere chamada ao Omie e expire o trigger_id
let _condicoesPagamentoCached = [];

async function preCarregarCondicoes() {
  try {
    _condicoesPagamentoCached = await listarCondicoesPagamento();
    console.log(`[COTAÇÃO] Condições de pagamento pré-carregadas: ${_condicoesPagamentoCached.length}`);
  } catch (err) {
    console.warn('[COTAÇÃO] Não foi possível pré-carregar condições de pagamento:', err.message);
  }
}

async function preCarregarFornecedores() {
  try {
    await carregarFornecedoresCompleto();
    console.log('[COTAÇÃO] Fornecedores pré-carregados no cache.');
  } catch (err) {
    console.warn('[COTAÇÃO] Não foi possível pré-carregar fornecedores:', err.message);
  }
}

// Pré-carrega em background — não bloqueia o servidor
preCarregarCondicoes();
preCarregarFornecedores();
const itensCache = new Map();

// Cache do estado de cotação de cada requisição, indexado por id_requisicao.
// Estrutura: { itens_pendentes, grupos, channel, message_ts }
// Perdido se o servidor reiniciar — aceitável pois cotação é feita em minutos.
const cotacaoCache = new Map();

const UNIDADES = ['PC', 'CX', 'KG', 'M', 'LT', 'GL', 'UN'];
const VALOR_NENHUM_DOS_ACIMA = '__nenhum_dos_acima__';

function referenciaDoItem(item) {
  if (item.area === 'AT') return item.num_tarefa || '';
  if (item.area === 'Reforma e Retrofit') {
    return item.maquina || item.projeto || item.num_tarefa || item.subconjunto || '';
  }
  return item.subconjunto || '';
}

function formatarItemSolicitado(item) {
  const linhas = [`*${item.descricao}* · ${item.quantidade} ${item.unidade}`];
  const referencia = referenciaDoItem(item);

  if (referencia) linhas.push(`_${referencia}_`);
  if (item.observacao) linhas.push(`> ${item.observacao}`);

  return linhas.join('\n');
}

// ── Monta e envia mensagem de requisição ─────────────────────
async function enviarMensagemRequisicao(idRequisicao, itensProcessados) {
  const canalId       = process.env.SLACK_CHANNEL_ID;
  const compradorId   = process.env.SLACK_COMPRADOR_ID   || '';
  const compradorNome = process.env.SLACK_COMPRADOR_NOME || 'Comprador';

  // Extrai contexto — como AT e Subconjunto nunca vêm juntos,
  // filtra pelo tipo correto para garantir que o cabeçalho seja sempre preciso.
  const itensAT  = itensProcessados.filter(i => i.area === 'AT');
  const itensSUB = itensProcessados.filter(i => i.area === 'Subconjunto');
  const itensRR  = itensProcessados.filter(i => i.area === 'Reforma e Retrofit');
  const itemRef  = itensAT.length > 0 ? itensAT[0]
    : itensSUB.length > 0 ? itensSUB[0]
    : itensRR[0] || {};

  const areaNome = itemRef.area === 'AT'
    ? 'Assistência Técnica'
    : itemRef.area === 'Reforma e Retrofit'
      ? 'Reforma e Retrofit'
      : 'Subconjunto';
  const solicitante  = itemRef.solicitante || '';
  const cliente      = itemRef.cliente     || '';
  const destinatario = compradorId ? `<@${compradorId}>` : compradorNome;
  const clienteTexto = cliente ? `*${cliente}*` : '*cliente não informado*';
  const contexto = `${destinatario}\n*${solicitante}* enviou uma requisição para ${clienteTexto}\n\`${idRequisicao}\` · pronta para análise`;

  const blocos = [];

  blocos.push({
    type: 'header',
    text: { type: 'plain_text', text: `📦 Nova Requisição de Compras — ${areaNome}`, emoji: true },
  });

  blocos.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: contexto,
    },
  });

  blocos.push({ type: 'divider' });

  itensProcessados.forEach(item => {
    // Guarda o item completo no cache para o modal poder consultar depois
    itensCache.set(item.id_item, item);

    blocos.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: formatarItemSolicitado(item),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Revisar', emoji: true },
        value: JSON.stringify({ id_item: item.id_item }),
        action_id: 'abrir_modal_revisao',
        style: 'primary',
      },
      block_id: `item_${item.id_item}`,
    });
  });

  const resultado = await app.client.chat.postMessage({
    channel: canalId,
    blocks: blocos,
    text: `Nova requisição ${idRequisicao}`,
  });

  // Cache em memória como fallback para aprovações no mesmo uptime do servidor
  mensagensCache.set(resultado.ts, {
    channel: resultado.channel,
    blocks: blocos,
    text: `Nova requisição ${idRequisicao}`,
  });

  // Retorna ts e channel para o server.js salvar na planilha (cache durável)
  return { ts: resultado.ts, channel: resultado.channel };
}

// ── Monta a view completa do modal de revisão ────────────────
function montarViewModalRevisao(item, metadata) {
  return {
    type: 'modal',
    callback_id: 'modal_revisao_submit',
    private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text', text: 'Revisar item' },
    submit: { type: 'plain_text', text: 'Confirmar' },
    close:  { type: 'plain_text', text: 'Fechar' },
    blocks: montarBlocksModalRevisao(item),
  };
}

// ── Monta os blocks do modal de revisão, com ou sem o formulário de cadastro revelado ─
function montarBlocksModalRevisao(item, { mostrarFormCadastro = false, valoresCadastro = {} } = {}) {
  const blocks = [];
  const semOpcoes = item.opcoes_similares.length === 0;

  // Se não há nenhuma opção similar, já mostra o formulário de cadastro
  // direto — não faz sentido pedir pro comprador "selecionar" algo
  // quando não existe nada pra selecionar.
  const exibirFormCadastro = mostrarFormCadastro || semOpcoes;

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: formatarItemSolicitado(item),
    },
  });

  if (!semOpcoes) {
    blocks.push({
      type: 'input',
      block_id: 'escolha_produto',
      label: { type: 'plain_text', text: 'Selecione o produto correspondente' },
      element: {
        type: 'radio_buttons',
        action_id: 'valor',
        options: [
          ...item.opcoes_similares.map((o, idx) => ({
            text: {
              type: 'plain_text',
              text: `${o.produto.descricao} (${o.produto.codigo}) — ${o.similaridade}%`.slice(0, 75),
            },
            value: String(idx),
          })),
          {
            text: { type: 'plain_text', text: '🆕 Nenhum dos acima — cadastrar produto novo' },
            value: VALOR_NENHUM_DOS_ACIMA,
          },
        ],
      },
      dispatch_action: true, // necessário para disparar block_actions ao selecionar
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_Nenhum produto similar encontrado — preencha os dados abaixo para cadastrar._' },
    });
  }

  if (exibirFormCadastro) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Dados para cadastro do produto novo*' },
    });
    blocks.push({
      type: 'input',
      block_id: 'descricao_cadastro',
      label: { type: 'plain_text', text: 'Descrição padronizada para o Omie' },
      element: {
        type: 'plain_text_input',
        action_id: 'valor',
        initial_value: valoresCadastro.descricao || item.descricao,
      },
    });
    blocks.push({
      type: 'input',
      block_id: 'ncm_cadastro',
      label: { type: 'plain_text', text: 'NCM' },
      element: {
        type: 'plain_text_input',
        action_id: 'valor',
        initial_value: valoresCadastro.ncm || item.ncm_sugerido || '',
        placeholder: { type: 'plain_text', text: 'Ex: 84821010' },
      },
      hint: item.ncm_descricao
        ? { type: 'plain_text', text: `Sugestão (${item.ncm_origem === 'historico_omie' ? 'histórico Omie' : 'tabela local'}): ${item.ncm_descricao}`.slice(0, 150) }
        : undefined,
      optional: true,
    });
    blocks.push({
      type: 'input',
      block_id: 'unidade_cadastro',
      label: { type: 'plain_text', text: 'Unidade' },
      element: {
        type: 'static_select',
        action_id: 'valor',
        placeholder: { type: 'plain_text', text: 'Selecione' },
        initial_option: UNIDADES.includes(item.unidade)
          ? { text: { type: 'plain_text', text: item.unidade }, value: item.unidade }
          : undefined,
        options: UNIDADES.map(u => ({ text: { type: 'plain_text', text: u }, value: u })),
      },
    });
    blocks.push({
      type: 'input',
      block_id: 'observacao_cadastro',
      label: { type: 'plain_text', text: 'Observação (opcional)' },
      element: { type: 'plain_text_input', action_id: 'valor', multiline: true },
      optional: true,
    });
  }

  return blocks;
}

// ── Action: Abrir modal de revisão ────────────────────────────
app.action('abrir_modal_revisao', async ({ ack, body, client }) => {
  await ack();
  const { id_item } = JSON.parse(body.actions[0].value);
  let item = itensCache.get(id_item);

  const metadataBase = {
    id_item,
    channel: body.channel.id,
    message_ts: body.message.ts,
  };

  // Se item está no cache, abre o modal diretamente com metadata correto
  if (item) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: montarViewModalRevisao(item, metadataBase),
    });
    return;
  }

  // Fallback: item não está no cache (servidor reiniciou)
  // Abre modal de carregamento imediatamente (trigger_id expira em 3s)
  // depois atualiza com os dados reais
  console.log(`[CACHE] Item ${id_item} não encontrado em memória, buscando da planilha...`);

  const viewCarregando = {
    type: 'modal',
    callback_id: 'modal_revisao_submit',
    private_metadata: JSON.stringify(metadataBase),
    title: { type: 'plain_text', text: 'Revisar item' },
    close: { type: 'plain_text', text: 'Fechar' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '⏳ _Carregando opções..._' } }],
  };

  const viewAberta = await client.views.open({ trigger_id: body.trigger_id, view: viewCarregando });

  try {
    item = await buscarItemParaModal(id_item);
    if (item) {
      const { processarItens } = require('../services/matcher');
      const [itemProcessado] = await processarItens([item]);
      item.opcoes_similares = itemProcessado.opcoes_similares || [];
      item.similaridade     = itemProcessado.similaridade     || 0;
      itensCache.set(id_item, item);
    }
  } catch (err) {
    console.error(`[CACHE] Erro ao buscar/recalcular item ${id_item}:`, err.message);
  }

  if (!item) {
    console.error(`[CACHE] Item ${id_item} não encontrado nem na planilha.`);
    return;
  }

  await client.views.update({
    view_id: viewAberta.view.id,
    view: montarViewModalRevisao(item, metadataBase),
  });
});

// ── Action: usuário selecionou uma opção no radio_buttons ────
// Detecta se foi "Nenhum dos acima" e atualiza o modal dinamicamente
// para revelar (ou esconder) o formulário de cadastro.
app.action('valor', async ({ ack, body, client }) => {
  await ack();

  // Esse action_id "valor" é usado em vários blocos (radio, inputs do form).
  // Só nos interessa reagir quando vem do radio_buttons de escolha de produto.
  const action = body.actions[0];
  if (action.type !== 'radio_buttons') return;

  const metadata = JSON.parse(body.view.private_metadata);
  const item = itensCache.get(metadata.id_item);
  if (!item) return;

  const selecionouNovo = action.selected_option?.value === VALOR_NENHUM_DOS_ACIMA;

  await client.views.update({
    view_id: body.view.id,
    view: {
      type: 'modal',
      callback_id: 'modal_revisao_submit',
      private_metadata: body.view.private_metadata,
      title: { type: 'plain_text', text: 'Revisar item' },
      submit: { type: 'plain_text', text: 'Confirmar' },
      close:  { type: 'plain_text', text: 'Fechar' },
      blocks: montarBlocksModalRevisao(item, { mostrarFormCadastro: selecionouNovo }),
    },
  });
});

// ── View submit: decide entre vincular produto existente ou cadastrar novo ─
app.view('modal_revisao_submit', async ({ ack, view, body, client }) => {
  const metadata = JSON.parse(view.private_metadata);
  let item = itensCache.get(metadata.id_item);
  const usuario = body.user.name;
  const values = view.state.values;

  // Fallback: item não está no cache (servidor reiniciou ou cache expirou)
  // Busca da planilha e recalcula as opções similares antes de prosseguir
  if (!item) {
    console.log(`[CACHE] Item ${metadata.id_item} não encontrado em memória no submit, buscando da planilha...`);
    try {
      item = await buscarItemParaModal(metadata.id_item);
      if (item) {
        const { processarItens } = require('../services/matcher');
        const [itemProcessado] = await processarItens([item]);
        item.opcoes_similares = itemProcessado.opcoes_similares || [];
        item.similaridade     = itemProcessado.similaridade     || 0;
        itensCache.set(metadata.id_item, item);
      }
    } catch (err) {
      console.error(`[CACHE] Erro ao buscar/recalcular item ${metadata.id_item} no submit:`, err.message);
    }
  }

  if (!item) {
    console.error(`[SUBMIT] Item ${metadata.id_item} não encontrado nem na planilha — abortando submit.`);
    await ack({
      response_action: 'errors',
      errors: { escolha_produto: 'Erro ao processar — feche e tente novamente.' },
    });
    return;
  }

  const escolha = values.escolha_produto?.valor?.selected_option?.value;
  const escolheuCadastrarNovo = escolha === VALOR_NENHUM_DOS_ACIMA || item.opcoes_similares.length === 0;

  if (escolheuCadastrarNovo) {
    const descricao  = values.descricao_cadastro?.valor?.value  || '';
    const ncm        = values.ncm_cadastro?.valor?.value        || '';
    const unidade    = values.unidade_cadastro?.valor?.selected_option?.value || '';
    const observacao = values.observacao_cadastro?.valor?.value || '';

    if (!descricao || !unidade) {
      await ack({
        response_action: 'errors',
        errors: {
          ...(!descricao ? { descricao_cadastro: 'Descrição é obrigatória' } : {}),
          ...(!unidade ? { unidade_cadastro: 'Unidade é obrigatória' } : {}),
        },
      });
      return;
    }

    await ack();
    console.log(`[CADASTRO] Item: ${metadata.id_item} | Por: ${usuario} | Descrição: ${descricao} | NCM: ${ncm} | Un: ${unidade}`);

    let codigoCriado = null;
    let avisoOmie = null;
    try {
      const resultado = await incluirProduto({ descricao, ncm, unidade, observacao });
      if (resultado.ok) {
        codigoCriado = resultado.codigo;
        console.log(`[CADASTRO] Produto criado no Omie: ${codigoCriado}`);
      } else {
        avisoOmie = resultado.motivo === 'descricao_duplicada'
          ? '⚠️ Descrição já existe no Omie — verifique se o produto já está cadastrado.'
          : `⚠️ Erro ao cadastrar no Omie: ${resultado.detalhe || resultado.motivo}`;
        console.warn(`[CADASTRO] Produto não criado no Omie: ${resultado.motivo}`);
      }
    } catch (err) {
      console.error(`[CADASTRO] Erro inesperado ao criar produto no Omie:`, err.message);
    }

    let todosRevisados = false;
    try {
      const resultadoStatus = await atualizarStatusItem(metadata.id_item, 'cadastrado', usuario);
      todosRevisados = resultadoStatus?.todosRevisados || false;
      console.log(`[CADASTRO] Status atualizado na planilha para item ${metadata.id_item}`);
    } catch (err) {
      console.error(`[CADASTRO] ERRO ao atualizar status na planilha para ${metadata.id_item}:`, err.message);
    }

    await atualizarBlocoItem(client, metadata, {
      emoji: '🆕',
      texto: `${formatarItemSolicitado(item)}\n*Cadastrado:* ${descricao}${codigoCriado ? ` _(código ${codigoCriado})_` : ''}${ncm ? ` _(NCM ${ncm})_` : ''}\n_Cadastrado por @${usuario}_${avisoOmie ? `\n${avisoOmie}` : ''}`,
    });

    if (todosRevisados) {
      await adicionarBotaoCotacao(client, metadata);
    }

  } else {
    if (escolha === undefined) {
      await ack({
        response_action: 'errors',
        errors: { escolha_produto: 'Selecione uma opção' },
      });
      return;
    }

    await ack();
    const opcaoEscolhida = item.opcoes_similares[Number(escolha)];

    console.log(`[REVISÃO] Item: ${metadata.id_item} | Por: ${usuario} | Produto vinculado: ${opcaoEscolhida.produto.descricao} (${opcaoEscolhida.produto.codigo})`);

    let todosRevisados = false;
    try {
      const resultadoStatus = await atualizarStatusItem(metadata.id_item, 'confirmado', usuario);
      todosRevisados = resultadoStatus?.todosRevisados || false;
      console.log(`[REVISÃO] Status atualizado na planilha para item ${metadata.id_item}`);
    } catch (err) {
      console.error(`[REVISÃO] ERRO ao atualizar status na planilha para ${metadata.id_item}:`, err.message);
    }

    await atualizarBlocoItem(client, metadata, {
      emoji: '✅',
      texto: `${formatarItemSolicitado(item)}\n*Vinculado:* ${opcaoEscolhida.produto.descricao} _(código ${opcaoEscolhida.produto.codigo})_\n_Confirmado por @${usuario}_`,
    });

    if (todosRevisados) {
      await adicionarBotaoCotacao(client, metadata);
    }
  }

  itensCache.delete(metadata.id_item);
});

// ── Action: Iniciar Cotação — abre Modal 1 (preços por item) ────
app.action('iniciar_cotacao', async ({ ack, body, client }) => {
  await ack();
  const { id_requisicao, channel, message_ts } = JSON.parse(body.actions[0].value);
  console.log(`[COTAÇÃO] Iniciar Cotação clicado para requisição ${id_requisicao} por ${body.user.name}`);

  let itens = [];
  try {
    itens = await buscarItensDaRequisicao(id_requisicao);
  } catch (err) {
    console.error(`[COTAÇÃO] Erro ao buscar itens da requisição ${id_requisicao}:`, err.message);
  }

  if (itens.length === 0) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Cotação' },
        close: { type: 'plain_text', text: 'Fechar' },
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `⚠️ Não foi possível carregar os itens de *${id_requisicao}*. Tente novamente.` },
        }],
      },
    });
    return;
  }

  // Slack limita modais a 100 blocos — cada item usa 1 bloco de input,
  // mais ~3 blocos fixos (título, divider). Acima de ~90 itens não cabe
  // num único modal; alertamos em vez de falhar silenciosamente.
  if (itens.length > 90) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Cotação' },
        close: { type: 'plain_text', text: 'Fechar' },
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `⚠️ Requisição *${id_requisicao}* tem ${itens.length} itens — excede o limite do modal do Slack. Contate o desenvolvedor para dividir a cotação.` },
        }],
      },
    });
    return;
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: montarViewModalPrecos(id_requisicao, itens, { channel, message_ts }),
  });
});

// ── Monta a view do Modal 1 — lista de itens com campo de preço cada um ─
function montarViewModalPrecos(idRequisicao, itens, metadata) {
  const blocks = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Requisição:* ${idRequisicao}\nPreencha o preço unitário de cada item:` },
  });
  blocks.push({ type: 'divider' });

  itens.forEach((item, idx) => {
    const nomeProduto = item.produto_omie || item.descricao;
    blocks.push({
      type: 'input',
      block_id: `preco_${item.id_item}`,
      label: {
        type: 'plain_text',
        text: `${nomeProduto} — ${item.quantidade} ${item.unidade}`.slice(0, 150),
      },
      element: {
        type: 'plain_text_input',
        action_id: 'valor',
        placeholder: { type: 'plain_text', text: 'Ex: 25,90' },
      },
    });
  });

  // Guarda os itens completos no metadata para o próximo passo (Modal 2)
  // não precisar buscar tudo de novo da planilha
  const metadataCompleto = {
    ...metadata,
    id_requisicao: idRequisicao,
    itens: itens.map(i => ({ id_item: i.id_item, descricao: i.produto_omie || i.descricao, quantidade: i.quantidade, unidade: i.unidade })),
  };

  return {
    type: 'modal',
    callback_id: 'modal_precos_submit',
    private_metadata: JSON.stringify(metadataCompleto),
    title: { type: 'plain_text', text: 'Cotação — Preços' },
    submit: { type: 'plain_text', text: 'Próximo' },
    close:  { type: 'plain_text', text: 'Cancelar' },
    blocks,
  };
}

// ── View submit: Modal 1 — valida e segue para Modal 2 ──────────
app.view('modal_precos_submit', async ({ ack, view, body, client }) => {
  const metadata = JSON.parse(view.private_metadata);
  const values = view.state.values;

  // Extrai e valida o preço de cada item
  const erros = {};
  const itensComPreco = metadata.itens.map(item => {
    const blockId = `preco_${item.id_item}`;
    const valorBruto = values[blockId]?.valor?.value || '';
    // Aceita vírgula ou ponto como separador decimal
    const preco = parseFloat(valorBruto.replace(',', '.'));

    if (!valorBruto || isNaN(preco) || preco <= 0) {
      erros[blockId] = 'Informe um preço válido';
    }

    return { ...item, preco_unitario: isNaN(preco) ? 0 : preco };
  });

  if (Object.keys(erros).length > 0) {
    await ack({ response_action: 'errors', errors: erros });
    return;
  }

  // Inicializa o estado de cotação no cache ANTES do ack para que montarViewModal2 funcione
  cotacaoCache.set(metadata.id_requisicao, {
    itens_pendentes: itensComPreco,
    grupos: [],
    channel: metadata.channel,
    message_ts: metadata.message_ts,
  });

  // ack() imediato — Slack exige resposta em até 3 segundos.
  // Usamos response_action:'update' direto no ack para trocar o modal
  // sem chamar client.views.update depois (evita race condition).
  await ack({
    response_action: 'update',
    view: montarViewModal2(metadata.id_requisicao),
  });

  // Log DEPOIS do ack para não atrasar a resposta ao Slack
  console.log(`[COTAÇÃO] Preços confirmados para ${metadata.id_requisicao} por ${body.user.name}`);
  itensComPreco.forEach(i => console.log(`  → ${i.descricao}: R$ ${i.preco_unitario.toFixed(2)}`));
});

// ── Monta a view do Modal 2 — agrupamento por fornecedor ────────
function montarViewModal2(idRequisicao) {
  const estado = cotacaoCache.get(idRequisicao);
  if (!estado) return null;

  const { itens_pendentes, grupos } = estado;
  const blocks = [];

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Requisição:* ${idRequisicao}\nSelecione os itens que serão comprados do mesmo fornecedor:`,
    },
  });

  // Mostra grupos já definidos
  if (grupos.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*✅ Fornecedores já definidos:*' },
    });
    grupos.forEach((grupo, idx) => {
      const nomes = grupo.itens.map(i => `• ${i.descricao} — ${i.quantidade} ${i.unidade} (R$ ${i.preco_unitario.toFixed(2)})`).join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${grupo.fornecedor.nome_fantasia || grupo.fornecedor.razao_social}* | Prazo: ${grupo.prazo} dias | ${grupo.condicao_descricao}\n${nomes}`,
        },
      });
    });
  }

  if (itens_pendentes.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'input',
      block_id: 'itens_selecionados',
      label: { type: 'plain_text', text: 'Itens para este fornecedor:' },
      element: {
        type: 'checkboxes',
        action_id: 'valor',
        options: itens_pendentes.map((item, idx) => ({
          text: {
            type: 'mrkdwn',
            text: `*${item.descricao}* — ${item.quantidade} ${item.unidade} | R$ ${item.preco_unitario.toFixed(2)} un`,
          },
          value: String(idx),
        })),
      },
    });
  }

  const todoDefinido = itens_pendentes.length === 0;

  return {
    type: 'modal',
    callback_id: 'modal2_definir_fornecedor',
    private_metadata: JSON.stringify({ id_requisicao: idRequisicao, todo_definido: todoDefinido }),
    title: { type: 'plain_text', text: 'Cotação — Fornecedores' },
    submit: {
      type: 'plain_text',
      text: todoDefinido ? '🛒 Criar Pedidos no Omie' : 'Definir Fornecedor →',
    },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks,
  };
}

// ── View submit: Modal 2 — seleciona itens e abre modal de fornecedor ─
// (também trata o caso de todos os itens definidos — "Criar Pedidos")
// Set para evitar processamento duplicado de submits — o Slack às vezes
// re-envia o evento quando o ack() demora, causando duplo processamento
const _submitsEmAndamento = new Set();

app.view('modal2_definir_fornecedor', async ({ ack, view, body, client }) => {
  const metadataBruto = view.private_metadata;
  let idRequisicao, todoDefinido;
  try {
    const parsed = JSON.parse(metadataBruto);
    idRequisicao = parsed.id_requisicao;
    todoDefinido = parsed.todo_definido;
  } catch {
    idRequisicao = metadataBruto;
    todoDefinido = false;
  }

  // Chave única por usuário + requisição + momento
  const chaveSubmit = `${body.user.id}-${idRequisicao}-${view.hash}`;
  if (_submitsEmAndamento.has(chaveSubmit)) {
    console.log(`[MODAL2] Submit duplicado ignorado — ${chaveSubmit}`);
    await ack();
    return;
  }
  _submitsEmAndamento.add(chaveSubmit);
  setTimeout(() => _submitsEmAndamento.delete(chaveSubmit), 10000);

  console.log(`[MODAL2] Submit recebido — req: ${idRequisicao} | todoDefinido: ${todoDefinido}`);

  const values = view.state.values;

  // Caso: todos os itens já foram definidos — cria os pedidos
  if (todoDefinido) {
    await ack();
    const estado = cotacaoCache.get(idRequisicao);
    if (!estado) return;
    const usuario = body.user.name;
    console.log(`[COTAÇÃO] Criando pedidos no Omie para ${idRequisicao} por ${usuario}`);
    estado.grupos.forEach(g => {
      console.log(`  → Fornecedor: ${g.fornecedor.nome_fantasia} | ${g.itens.length} item(ns) | Prazo: ${g.prazo}d | ${g.condicao_descricao}`);
    });
    // TODO: implementar IncluirPedCompra para cada grupo — próxima etapa
    await client.chat.postEphemeral({
      channel: estado.channel,
      user: body.user.id,
      text: `✅ *${estado.grupos.length} grupo(s)* definido(s) para *${idRequisicao}*. Criação do pedido no Omie em implementação.`,
    });
    cotacaoCache.delete(idRequisicao);
    return;
  }

  // Caso: seleciona itens para o próximo fornecedor
  const selecionados = values.itens_selecionados?.valor?.selected_options || [];

  if (selecionados.length === 0) {
    await ack({
      response_action: 'errors',
      errors: { itens_selecionados: 'Selecione ao menos um item' },
    });
    return;
  }

  const estado = cotacaoCache.get(idRequisicao);
  if (!estado) {
    await ack();
    return;
  }

  const indicesSelecionados = selecionados.map(o => Number(o.value));
  const itensSelecionados = indicesSelecionados.map(i => estado.itens_pendentes[i]);

  estado._itens_em_atribuicao = itensSelecionados;
  cotacaoCache.set(idRequisicao, estado);

  const condicoes = _condicoesPagamentoCached;

  await ack({
    response_action: 'update',
    view: montarViewModalFornecedor(idRequisicao, itensSelecionados, condicoes),
  });
});

// ── Monta a view do Modal de Fornecedor ─────────────────────────
function montarViewModalFornecedor(idRequisicao, itensSelecionados, condicoes) {
  const resumoItens = itensSelecionados
    .map(i => `• ${i.descricao} — ${i.quantidade} ${i.unidade}`)
    .join('\n');

  const opcoesCondicoes = condicoes.slice(0, 25).map((c, idx) => ({
    text: { type: 'plain_text', text: (c.cDescricao || 'Sem descrição').slice(0, 75) },
    value: String(c.cCodigo || idx),
  }));

  // Fallback se não houver condições do Omie
  if (opcoesCondicoes.length === 0) {
    ['À vista', '30 dias', '30/60 dias', '30/60/90 dias'].forEach((d, i) => {
      opcoesCondicoes.push({ text: { type: 'plain_text', text: d }, value: String(i) });
    });
  }

  return {
    type: 'modal',
    callback_id: 'modal_fornecedor_submit',
    private_metadata: JSON.stringify({ id_requisicao: idRequisicao }),
    title: { type: 'plain_text', text: 'Definir Fornecedor' },
    submit: { type: 'plain_text', text: 'Confirmar' },
    close: { type: 'plain_text', text: 'Voltar' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Itens selecionados:*\n${resumoItens}` },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'busca_fornecedor',
        label: { type: 'plain_text', text: 'Fornecedor' },
        hint: { type: 'plain_text', text: 'Digite o nome ou parte do nome. Se houver mais de um resultado, você será avisado.' },
        element: {
          type: 'plain_text_input',
          action_id: 'valor',
          placeholder: { type: 'plain_text', text: 'Ex: CLD Maquinas, RTE Distribuidora...' },
        },
      },
      {
        type: 'input',
        block_id: 'prazo_entrega',
        label: { type: 'plain_text', text: 'Prazo de entrega (dias)' },
        element: {
          type: 'plain_text_input',
          action_id: 'valor',
          placeholder: { type: 'plain_text', text: 'Ex: 7' },
        },
      },
      {
        type: 'input',
        block_id: 'condicao_pagamento',
        label: { type: 'plain_text', text: 'Condição de pagamento' },
        element: {
          type: 'plain_text_input',
          action_id: 'valor',
          placeholder: { type: 'plain_text', text: 'Ex: À vista, 30 dias, 30/60/90 dias' },
        },
      },
      {
        type: 'input',
        block_id: 'obs_fornecedor',
        label: { type: 'plain_text', text: 'Observação (opcional)' },
        element: { type: 'plain_text_input', action_id: 'valor', multiline: true },
        optional: true,
      },
    ],
  };
}

// ── Options handler: busca de fornecedor via external_select ────
app.options('valor', async ({ options, ack }) => {
  const query = (options.value || '').toLowerCase().trim();
  let fornecedores = [];
  try {
    fornecedores = await buscarFornecedoresPorTexto(query, 10);
  } catch (err) {
    console.error('[COTAÇÃO] Erro na busca de fornecedor:', err.message);
  }

  await ack({
    options: fornecedores.map(f => {
      const nome = (f.nome_fantasia || f.razao_social || '').trim();
      const razao = (f.razao_social || '').trim();
      const label = nome !== razao && razao ? `${nome} (${razao})`.slice(0, 75) : nome.slice(0, 75);
      return {
        text: { type: 'plain_text', text: label || 'Sem nome' },
        value: JSON.stringify({
          codigo: f.codigo_cliente_omie,
          nome_fantasia: f.nome_fantasia || f.razao_social,
          razao_social: f.razao_social,
        }),
      };
    }),
  });
});

// ── View submit: Modal Fornecedor — confirma e volta pro Modal 2 ─
app.view('modal_fornecedor_submit', async ({ ack, view, body, client }) => {
  const { id_requisicao } = JSON.parse(view.private_metadata);
  console.log(`[FORNECEDOR] Submit recebido — req: ${id_requisicao} | usuário: ${body.user.name}`);
  const values = view.state.values;
  const estado = cotacaoCache.get(id_requisicao);

  if (!estado) {
    await ack();
    return;
  }

  const textoBusca = (values.busca_fornecedor?.valor?.value || '').trim();
  const prazo = values.prazo_entrega?.valor?.value || '';
  const condicao = values.condicao_pagamento?.valor?.value || '';
  const obs = values.obs_fornecedor?.valor?.value || '';

  if (!textoBusca || !prazo || !condicao) {
    await ack({
      response_action: 'errors',
      errors: {
        ...(!textoBusca ? { busca_fornecedor: 'Informe o nome do fornecedor' } : {}),
        ...(!prazo ? { prazo_entrega: 'Informe o prazo' } : {}),
        ...(!condicao ? { condicao_pagamento: 'Informe a condição de pagamento' } : {}),
      },
    });
    return;
  }

  // Busca SÍNCRONA no cache em memória — evita await antes do ack()
  // Se o cache não estiver pronto, faz a busca mas aceita o risco de timeout
  let resultados = [];
  try {
    resultados = await Promise.race([
      buscarFornecedoresPorTexto(textoBusca, 5),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
  } catch (err) {
    await ack({
      response_action: 'errors',
      errors: { busca_fornecedor: 'Busca demorou demais. Tente novamente — o cache estará pronto.' },
    });
    return;
  }

  if (resultados.length === 0) {
    await ack({
      response_action: 'errors',
      errors: { busca_fornecedor: `Nenhum fornecedor encontrado para "${textoBusca}". Tente outro nome.` },
    });
    return;
  }

  if (resultados.length > 1) {
    const nomes = resultados.map(f => f.nome_fantasia || f.razao_social).join(', ');
    await ack({
      response_action: 'errors',
      errors: { busca_fornecedor: `${resultados.length} encontrados: ${nomes.slice(0, 200)}. Seja mais específico.` },
    });
    return;
  }

  const fornecedor = {
    codigo: resultados[0].codigo_cliente_omie,
    nome_fantasia: resultados[0].nome_fantasia || resultados[0].razao_social,
    razao_social: resultados[0].razao_social,
  };
  const itensSelecionados = estado._itens_em_atribuicao || [];

  // Adiciona o grupo ao estado
  estado.grupos.push({
    fornecedor,
    prazo,
    condicao_descricao: condicao,
    obs,
    itens: itensSelecionados,
  });

  // Remove os itens atribuídos da lista de pendentes
  const idsSelecionados = new Set(itensSelecionados.map(i => i.id_item));
  estado.itens_pendentes = estado.itens_pendentes.filter(i => !idsSelecionados.has(i.id_item));
  estado._itens_em_atribuicao = [];
  cotacaoCache.set(id_requisicao, estado);

  console.log(`[COTAÇÃO] Grupo definido: ${fornecedor.nome_fantasia} — ${itensSelecionados.length} item(ns)`);

  const estadoAtualizado = cotacaoCache.get(id_requisicao);
  const todoDefinido = estadoAtualizado.itens_pendentes.length === 0;

  if (todoDefinido) {
    // Todos os itens têm fornecedor — mostra tela de revisão final
    await ack({
      response_action: 'update',
      view: montarViewRevisaoFinal(id_requisicao),
    });
  } else {
    // Ainda há itens pendentes — volta pro Modal 2 com os itens restantes
    await ack({
      response_action: 'update',
      view: montarViewModal2(id_requisicao),
    });
  }
});

// ── Monta a view de revisão final — resumo de todos os grupos ───
function montarViewRevisaoFinal(idRequisicao) {
  const estado = cotacaoCache.get(idRequisicao);
  if (!estado) return null;

  const blocks = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Revisão da Cotação — ${idRequisicao}*\nConfira os pedidos abaixo antes de criar no Omie:` },
  });
  blocks.push({ type: 'divider' });

  estado.grupos.forEach((grupo, idx) => {
    const nomeFornecedor = grupo.fornecedor.nome_fantasia || grupo.fornecedor.razao_social;
    const itensTexto = grupo.itens
      .map(i => `• ${i.descricao} — ${i.quantidade} ${i.unidade} | R$ ${i.preco_unitario.toFixed(2)} un`)
      .join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Pedido ${idx + 1}:* ${nomeFornecedor}\n*Prazo:* ${grupo.prazo} dias | *Cond:* ${grupo.condicao_descricao}\n${itensTexto}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '✏️ Editar', emoji: true },
        value: JSON.stringify({ id_requisicao: idRequisicao, grupo_idx: idx }),
        action_id: 'editar_grupo_fornecedor',
      },
    });

    if (idx < estado.grupos.length - 1) {
      blocks.push({ type: 'divider' });
    }
  });

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '← Voltar', emoji: true },
      value: idRequisicao,
      action_id: 'voltar_ao_modal2',
    }],
  });

  return {
    type: 'modal',
    callback_id: 'modal_revisao_final_submit',
    private_metadata: idRequisicao,
    title: { type: 'plain_text', text: 'Revisão Final' },
    submit: { type: 'plain_text', text: '🛒 Criar Pedidos no Omie' },
    close:  { type: 'plain_text', text: 'Cancelar' },
    blocks,
  };
}

// ── Action: Voltar ao Modal 2 a partir da revisão final ────────
app.action('voltar_ao_modal2', async ({ ack, body, client }) => {
  await ack();
  const idRequisicao = body.actions[0].value;
  await client.views.update({
    view_id: body.view.id,
    view: montarViewModal2(idRequisicao),
  });
});

// ── Action: Editar um grupo de fornecedor na revisão final ──────
app.action('editar_grupo_fornecedor', async ({ ack, body, client }) => {
  await ack();
  const { id_requisicao, grupo_idx } = JSON.parse(body.actions[0].value);
  const estado = cotacaoCache.get(id_requisicao);
  if (!estado) return;

  const grupo = estado.grupos[grupo_idx];
  if (!grupo) return;

  // Devolve os itens do grupo para a lista de pendentes e remove o grupo
  estado.itens_pendentes = [...estado.itens_pendentes, ...grupo.itens];
  estado.grupos.splice(grupo_idx, 1);
  estado._itens_em_atribuicao = grupo.itens;
  cotacaoCache.set(id_requisicao, estado);

  // Abre o modal de fornecedor para reeditar — usa views.update na view atual
  await client.views.update({
    view_id: body.view.id,
    view: montarViewModalFornecedorEdicao(id_requisicao, grupo.itens, grupo),
  });
});

// ── Modal de fornecedor para edição — pré-preenchido com valores anteriores ─
function montarViewModalFornecedorEdicao(idRequisicao, itensSelecionados, grupoAnterior) {
  const resumoItens = (itensSelecionados || [])
    .filter(i => i && i.descricao)
    .map(i => `• ${i.descricao} — ${i.quantidade} ${i.unidade}`)
    .join('\n');

  return {
    type: 'modal',
    callback_id: 'modal_fornecedor_submit',
    private_metadata: JSON.stringify({ id_requisicao: idRequisicao }),
    title: { type: 'plain_text', text: 'Editar Fornecedor' },
    submit: { type: 'plain_text', text: 'Confirmar' },
    close:  { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Itens selecionados:*\n${resumoItens}` },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'busca_fornecedor',
        label: { type: 'plain_text', text: 'Fornecedor' },
        hint: { type: 'plain_text', text: 'Digite o nome ou parte do nome.' },
        element: {
          type: 'plain_text_input',
          action_id: 'valor',
          initial_value: grupoAnterior?.fornecedor?.nome_fantasia || '',
          placeholder: { type: 'plain_text', text: 'Ex: CLD Maquinas, RTE Distribuidora...' },
        },
      },
      {
        type: 'input',
        block_id: 'prazo_entrega',
        label: { type: 'plain_text', text: 'Prazo de entrega (dias)' },
        element: {
          type: 'plain_text_input',
          action_id: 'valor',
          initial_value: grupoAnterior?.prazo || '',
          placeholder: { type: 'plain_text', text: 'Ex: 7' },
        },
      },
      {
        type: 'input',
        block_id: 'condicao_pagamento',
        label: { type: 'plain_text', text: 'Condição de pagamento' },
        element: {
          type: 'plain_text_input',
          action_id: 'valor',
          initial_value: grupoAnterior?.condicao_descricao || '',
          placeholder: { type: 'plain_text', text: 'Ex: À vista, 30 dias, 30/60/90 dias' },
        },
      },
      {
        type: 'input',
        block_id: 'obs_fornecedor',
        label: { type: 'plain_text', text: 'Observação (opcional)' },
        element: {
          type: 'plain_text_input',
          action_id: 'valor',
          initial_value: grupoAnterior?.obs || '',
          multiline: true,
        },
        optional: true,
      },
    ],
  };
}

// ── View submit: Revisão final — cria os pedidos no Omie ────────
app.view('modal_revisao_final_submit', async ({ ack, view, body, client }) => {
  await ack();

  const idRequisicao = view.private_metadata;
  const estado = cotacaoCache.get(idRequisicao);
  if (!estado) return;

  const usuario = body.user.name;
  console.log(`[COTAÇÃO] Criando pedidos no Omie para ${idRequisicao} por ${usuario}`);

  const pedidosCriados = [];
  const erros = [];

  for (let idx = 0; idx < estado.grupos.length; idx++) {
    const grupo = estado.grupos[idx];
    try {
      const resultado = await incluirPedidoCompra({ idRequisicao, grupo, idxGrupo: idx });
      pedidosCriados.push({ ...resultado, fornecedor: grupo.fornecedor.nome_fantasia });
    } catch (err) {
      console.error(`[COTAÇÃO] Erro ao criar pedido para ${grupo.fornecedor.nome_fantasia}:`, err.message);
      erros.push({ fornecedor: grupo.fornecedor.nome_fantasia, erro: err.message });
    }
  }

  // Atualiza o Histórico com status "Pedido criado" se tudo foi bem
  if (pedidosCriados.length > 0) {
    try {
      const { atualizarStatusHistorico } = require('../services/sheets');
      await atualizarStatusHistorico(idRequisicao, 'Pedido criado');
    } catch (err) {
      console.error('[COTAÇÃO] Erro ao atualizar Histórico:', err.message);
    }
  }

  // Atualiza a mensagem no Slack com os números dos pedidos
  const mensagemAtual = mensagensCache.get(estado.message_ts);
  if (mensagemAtual) {
    const numeros = pedidosCriados.map(p => `*${p.cNumero}* (${p.fornecedor})`).join(', ');
    const textoFinal = pedidosCriados.length > 0
      ? `✅ *Pedidos criados no Omie:* ${numeros}`
      : `⚠️ Erro ao criar pedidos no Omie.`;

    const novosBlocos = [
      ...mensagemAtual.blocks,
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: textoFinal } },
    ];

    try {
      await client.chat.update({
        channel: estado.channel,
        ts: estado.message_ts,
        blocks: novosBlocos,
        text: mensagemAtual.text,
      });
      mensagensCache.set(estado.message_ts, { ...mensagemAtual, blocks: novosBlocos });
    } catch (err) {
      console.error('[COTAÇÃO] Erro ao atualizar mensagem Slack:', err.message);
    }
  }

  // Feedback para o comprador
  const textoEphemeral = pedidosCriados.length === estado.grupos.length
    ? `✅ *${pedidosCriados.length} pedido(s)* criados no Omie para *${idRequisicao}*: ${pedidosCriados.map(p => `Nº ${p.cNumero}`).join(', ')}`
    : `⚠️ *${pedidosCriados.length}/${estado.grupos.length}* pedidos criados. Erros: ${erros.map(e => e.fornecedor).join(', ')}`;

  await client.chat.postEphemeral({
    channel: estado.channel,
    user: body.user.id,
    text: textoEphemeral,
  });

  cotacaoCache.delete(idRequisicao);
});

// ── Helper: atualiza o bloco de um item específico na mensagem original ─
async function atualizarBlocoItem(client, metadata, { emoji, texto }) {
  try {
    let mensagemAtual = mensagensCache.get(metadata.message_ts);

    // Fallback: cache em memória perdido (restart do servidor)
    // Reconstrói a mensagem via conversations.history usando o ts salvo na planilha
    if (!mensagemAtual) {
      console.log(`[SLACK] Cache vazio para ${metadata.message_ts}, buscando via conversations.history...`);
      try {
        const history = await client.conversations.history({
          channel: metadata.channel,
          latest: metadata.message_ts,
          inclusive: true,
          limit: 1,
        });
        const msg = history.messages?.[0];
        if (msg) {
          mensagemAtual = { channel: metadata.channel, blocks: msg.blocks || [], text: msg.text || '' };
          mensagensCache.set(metadata.message_ts, mensagemAtual);
        }
      } catch (histErr) {
        console.error('[SLACK] Não foi possível buscar mensagem via conversations.history:', histErr.message);
        return;
      }
    }

    if (!mensagemAtual) {
      console.error(`[SLACK] Mensagem ${metadata.message_ts} não encontrada.`);
      return;
    }

    const blockId = `item_${metadata.id_item}`;

    const novosBlocos = mensagemAtual.blocks.map(b => {
      if (b.block_id === blockId) {
        return {
          type: 'section',
          block_id: blockId,
          text: { type: 'mrkdwn', text: `${emoji} ${texto}` },
        };
      }
      return b;
    });

    await client.chat.update({
      channel: metadata.channel,
      ts: metadata.message_ts,
      blocks: novosBlocos,
      text: mensagemAtual.text,
    });

    mensagensCache.set(metadata.message_ts, { ...mensagemAtual, blocks: novosBlocos });

  } catch (err) {
    console.error('Erro ao atualizar mensagem do Slack:', err.message);
  }
}

// ── Helper: adiciona o botão "Iniciar Cotação" no final da mensagem ─────
// Chamado quando o último item de uma requisição é revisado (confirmado/cadastrado).
async function adicionarBotaoCotacao(client, metadata) {
  try {
    const mensagemAtual = mensagensCache.get(metadata.message_ts);
    if (!mensagemAtual) {
      console.error(`[COTAÇÃO] Mensagem ${metadata.message_ts} não encontrada no cache para adicionar botão.`);
      return;
    }

    // Extrai o id_requisicao do block_id de algum item já existente
    // (formato: item_REQ-XXXX-AT-4) para usar no value do botão
    const idRequisicao = metadata.id_item.split('-').slice(0, -2).join('-');

    const blocosComBotao = [
      ...mensagemAtual.blocks,
      { type: 'divider' },
      {
        type: 'section',
        block_id: 'bloco_iniciar_cotacao',
        text: { type: 'mrkdwn', text: '✅ *Todos os itens revisados!* Pronto para iniciar a cotação.' },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '💰 Iniciar Cotação', emoji: true },
          value: JSON.stringify({ id_requisicao: idRequisicao, channel: metadata.channel, message_ts: metadata.message_ts }),
          action_id: 'iniciar_cotacao',
          style: 'primary',
        },
      },
    ];

    await client.chat.update({
      channel: metadata.channel,
      ts: metadata.message_ts,
      blocks: blocosComBotao,
      text: mensagemAtual.text,
    });

    mensagensCache.set(metadata.message_ts, { ...mensagemAtual, blocks: blocosComBotao });
    console.log(`[COTAÇÃO] Botão "Iniciar Cotação" adicionado para requisição ${idRequisicao}`);

  } catch (err) {
    console.error('[COTAÇÃO] Erro ao adicionar botão de cotação:', err.message);
  }
}

module.exports = { app, enviarMensagemRequisicao, expressApp };