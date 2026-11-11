// Fluxo 1 — revisão de cada item: vincular a um produto do Omie ou cadastrar novo.

const { app, itensCache, chaveItem, nomeUsuario, avisarUsuario } = require('./app');
const {
  VALOR_PRODUTO_NOVO, escapar, viewCarregando, viewAviso, lerMetadata,
  formatarItemSolicitado, montarViewRevisao,
} = require('./blocos');
const { atualizarBlocoItem, adicionarBotaoCotacao } = require('./mensagens');
const { processarItens, buscarProdutoPorCodigoOmie } = require('../services/matcher');
const { atualizarStatusItem, buscarItemParaModal } = require('../services/sheets');
const { incluirProduto } = require('../services/omieService');
const { ambienteDoCanal } = require('../config/environment');

// Recalcula as sugestões de um item (cache perdido no restart ou catálogo
// indisponível no momento do envio). Busca o item na planilha se preciso.
async function recarregarItem(ctx, itemBase) {
  const base = itemBase || await buscarItemParaModal(ctx.id_item, ctx.id_requisicao, ctx.ambiente);
  if (!base) throw new Error(`Item ${ctx.id_item} não encontrado na planilha.`);
  const [item] = await processarItens([base]);
  item.id_requisicao = base.id_requisicao || ctx.id_requisicao;
  itensCache.set(chaveItem({ ...ctx, id_requisicao: item.id_requisicao }), item);
  return item;
}

// ── Abrir modal ──────────────────────────────────────────────
app.action('abrir_modal_revisao', async ({ ack, body, client }) => {
  await ack();
  const valor = JSON.parse(body.actions[0].value);
  // Mensagens antigas só tinham id_item no botão — ambiente vem do canal
  const ctx = {
    id_item: valor.id_item,
    id_requisicao: valor.id_requisicao || null,
    ambiente: valor.ambiente || ambienteDoCanal(body.channel.id),
    channel: body.channel.id,
    message_ts: body.message.ts,
  };

  const emCache = itensCache.get(chaveItem(ctx));
  if (emCache && !emCache.catalogo_indisponivel) {
    await client.views.open({ trigger_id: body.trigger_id, view: montarViewRevisao(emCache, ctx) });
    return;
  }

  // trigger_id expira em 3s: abre um modal de "carregando" e atualiza depois
  const aberta = await client.views.open({ trigger_id: body.trigger_id, view: viewCarregando('Revisar item') });
  try {
    const item = await recarregarItem(ctx, emCache);
    ctx.id_requisicao = item.id_requisicao;
    await client.views.update({ view_id: aberta.view.id, view: montarViewRevisao(item, ctx) });
  } catch (err) {
    console.error(`[REVISÃO] Erro ao carregar item ${ctx.id_item}:`, err.message);
    await client.views.update({ view_id: aberta.view.id, view: viewAviso('Revisar item', `⚠️ Não foi possível carregar o item: ${escapar(err.message)}`) });
  }
});

// ── Troca de opção no radio: mostra/esconde o formulário de cadastro ─
app.action('escolha_radio', async ({ ack, body, client }) => {
  await ack();
  const ctx = lerMetadata(body.view);
  const item = itensCache.get(chaveItem(ctx));
  if (!item) return;

  const selecionado = body.actions[0].selected_option?.value;
  const querCadastrar = selecionado === VALOR_PRODUTO_NOVO;
  const formVisivel = body.view.blocks.some(b => b.block_id === 'descricao_cadastro');
  if (querCadastrar === formVisivel) return; // nada muda na tela

  await client.views.update({
    view_id: body.view.id,
    view: montarViewRevisao(item, ctx, { mostrarFormCadastro: querCadastrar, selecionado }),
  });
});

// ── Submit ───────────────────────────────────────────────────
function validarCadastro(values) {
  const dados = {
    descricao:  (values.descricao_cadastro?.valor?.value || '').trim(),
    ncm:        (values.ncm_cadastro?.valor?.value || '').replace(/\D/g, ''),
    unidade:    values.unidade_cadastro?.valor?.selected_option?.value || '',
    observacao: (values.observacao_cadastro?.valor?.value || '').trim(),
  };
  const erros = {};
  if (!dados.descricao) erros.descricao_cadastro = 'Descrição é obrigatória';
  if (dados.descricao.length > 120) erros.descricao_cadastro = 'Máximo de 120 caracteres';
  if (dados.ncm && dados.ncm.length !== 8) erros.ncm_cadastro = 'NCM deve ter 8 dígitos';
  if (!dados.unidade) erros.unidade_cadastro = 'Unidade é obrigatória';
  return { dados, erros };
}

app.view('modal_revisao_submit', async ({ ack, view, body, client }) => {
  const ctx = lerMetadata(view);
  const values = view.state.values;
  const escolha = values.escolha_produto?.escolha_radio?.selected_option?.value;
  const cadastrarNovo = escolha === VALOR_PRODUTO_NOVO || (!escolha && Boolean(values.descricao_cadastro));

  if (!ctx.id_item) {
    await ack({ response_action: 'errors', errors: { [view.blocks.find(b => b.type === 'input')?.block_id || 'escolha_produto']: 'Modal inválido — feche e abra novamente.' } });
    return;
  }

  let dadosCadastro;
  if (cadastrarNovo) {
    const { dados, erros } = validarCadastro(values);
    if (Object.keys(erros).length > 0) {
      await ack({ response_action: 'errors', errors: erros });
      return;
    }
    dadosCadastro = dados;
  } else if (!escolha) {
    await ack({ response_action: 'errors', errors: { escolha_produto: 'Selecione uma opção' } });
    return;
  }

  // Cadastro no Omie e planilha levam mais que os 3s permitidos — fecha o modal já
  await ack();

  const usuario = nomeUsuario(body.user);
  try {
    const item = itensCache.get(chaveItem(ctx)) || await recarregarItem(ctx);
    ctx.id_requisicao = ctx.id_requisicao || item.id_requisicao;

    if (cadastrarNovo) {
      await concluirCadastro(client, ctx, item, dadosCadastro, usuario);
    } else {
      await concluirVinculo(client, ctx, item, escolha, usuario);
    }
  } catch (err) {
    console.error(`[REVISÃO] Erro ao concluir revisão do item ${ctx.id_item}:`, err.message);
    await avisarUsuario(client, ctx.channel, body.user.id, `⚠️ Não foi possível concluir a revisão do item *${escapar(ctx.id_item)}*: ${escapar(err.message)}. Tente novamente.`);
  }
});

async function finalizarItem(client, ctx, { status, usuario, produto, texto }) {
  const { idRequisicao, todosRevisados } = await atualizarStatusItem({
    idItem: ctx.id_item, idRequisicao: ctx.id_requisicao, status, usuario, produto, ambiente: ctx.ambiente,
  });
  ctx.id_requisicao = idRequisicao;
  await atualizarBlocoItem(client, ctx, texto);
  itensCache.delete(chaveItem(ctx));
  if (todosRevisados) await adicionarBotaoCotacao(client, ctx);
}

async function concluirVinculo(client, ctx, item, escolha, usuario) {
  const opcao = (item.opcoes_similares || []).find(o => String(o.produto.codigo_omie) === escolha);
  const produto = opcao?.produto || await buscarProdutoPorCodigoOmie(escolha);
  if (!produto?.codigo_omie) throw new Error('Produto selecionado não encontrado no catálogo do Omie');

  console.log(`[REVISÃO] ${ctx.id_item} | ${usuario} | vinculado: ${produto.descricao} (${produto.codigo})`);
  await finalizarItem(client, ctx, {
    status: 'confirmado',
    usuario,
    produto,
    texto: `✅ ${formatarItemSolicitado(item)}\n*Vinculado:* ${escapar(produto.descricao)} _(código ${escapar(produto.codigo)})_\n_Confirmado por @${escapar(usuario)}_`,
  });
}

async function concluirCadastro(client, ctx, item, dados, usuario) {
  console.log(`[CADASTRO] ${ctx.id_item} | ${usuario} | ${dados.descricao} | NCM ${dados.ncm || '-'} | ${dados.unidade}`);
  const resultado = await incluirProduto(dados);

  if (!resultado.ok) {
    // Sem produto no Omie o item não pode virar pedido: fica pendente e o
    // botão "Revisar" continua na mensagem para nova tentativa.
    const aviso = resultado.motivo === 'descricao_duplicada'
      ? '⚠️ Essa descrição já existe no Omie (o produto pode estar inativo). Revise e escolha o produto existente ou ajuste a descrição.'
      : `⚠️ Erro ao cadastrar no Omie: ${escapar(resultado.detalhe || resultado.motivo)}`;
    await atualizarStatusItem({ idItem: ctx.id_item, idRequisicao: ctx.id_requisicao, status: 'aguardando_cadastro', usuario, ambiente: ctx.ambiente });
    await atualizarBlocoItem(client, ctx, `${formatarItemSolicitado(item)}\n${aviso}`, { comBotao: true });
    return;
  }

  await finalizarItem(client, ctx, {
    status: 'cadastrado',
    usuario,
    produto: { descricao: resultado.descricao, codigo_omie: resultado.codigo_omie, ncm: resultado.ncm },
    texto: `🆕 ${formatarItemSolicitado(item)}\n*Cadastrado:* ${escapar(resultado.descricao)} _(código ${resultado.codigo})_${resultado.ncm ? ` _(NCM ${resultado.ncm})_` : ''}\n_Cadastrado por @${escapar(usuario)}_`,
  });
}
