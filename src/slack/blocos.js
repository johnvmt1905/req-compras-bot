// Helpers de Block Kit + montagem de todas as views (modais) do bot.
// Os limites do Slack (tamanho de texto, nº de opções, nº de blocos) são
// respeitados aqui — ultrapassá-los faz o Slack rejeitar a view inteira.

const LIMITES = {
  TITULO_MODAL: 24,
  TEXTO_OPCAO: 75,
  TEXTO_SECAO: 3000,
  LABEL: 2000,
  OPCOES_CHECKBOX: 10,
  BLOCOS_MODAL: 100,
};

const UNIDADES = ['PC', 'CX', 'KG', 'M', 'LT', 'GL', 'UN'];
const VALOR_PRODUTO_NOVO = '__nenhum_dos_acima__';

const limitar = (texto, max) => {
  const t = String(texto ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
// Texto vindo do usuário pode conter <, > e & — no mrkdwn isso vira link/menção quebrada
const escapar = (texto) => String(texto ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plain = (texto, max = LIMITES.LABEL) => ({ type: 'plain_text', text: limitar(texto, max) || ' ', emoji: true });
const secao = (texto, extra = {}) => ({ type: 'section', text: { type: 'mrkdwn', text: limitar(texto, LIMITES.TEXTO_SECAO) }, ...extra });
const divisor = (blockId) => (blockId ? { type: 'divider', block_id: blockId } : { type: 'divider' });
const opcao = (texto, valor, descricao) => ({
  text: plain(texto, LIMITES.TEXTO_OPCAO),
  value: String(valor),
  ...(descricao ? { description: plain(descricao, LIMITES.TEXTO_OPCAO) } : {}),
});
const moeda = (valor) => Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function inputTexto(blockId, label, { initial, placeholder, multiline = false, optional = false, hint } = {}) {
  return {
    type: 'input',
    block_id: blockId,
    label: plain(label),
    optional,
    ...(hint ? { hint: plain(hint) } : {}),
    element: {
      type: 'plain_text_input',
      action_id: 'valor',
      multiline,
      ...(initial ? { initial_value: String(initial) } : {}),
      ...(placeholder ? { placeholder: plain(placeholder, 150) } : {}),
    },
  };
}

function modal({ callbackId, titulo, submit, close = 'Fechar', metadata, blocks }) {
  return {
    type: 'modal',
    ...(callbackId ? { callback_id: callbackId } : {}),
    private_metadata: metadata ? JSON.stringify(metadata) : '',
    title: plain(titulo, LIMITES.TITULO_MODAL),
    ...(submit ? { submit: plain(submit, LIMITES.TITULO_MODAL) } : {}),
    close: plain(close, LIMITES.TITULO_MODAL),
    blocks: blocks.slice(0, LIMITES.BLOCOS_MODAL),
  };
}

const viewCarregando = (titulo) => modal({ titulo, blocks: [secao('⏳ _Carregando..._')] });
const viewAviso = (titulo, texto) => modal({ titulo, blocks: [secao(texto)] });

function lerMetadata(view) {
  try {
    return JSON.parse(view.private_metadata || '{}');
  } catch {
    return {};
  }
}

// ── Item da requisição ───────────────────────────────────────
function referenciaDoItem(item) {
  if (item.area === 'AT') return item.num_tarefa || '';
  if (item.area === 'Reforma e Retrofit') return item.maquina || item.projeto || item.num_tarefa || item.subconjunto || '';
  return item.subconjunto || '';
}

function formatarItemSolicitado(item) {
  const linhas = [`*${escapar(item.descricao)}* · ${escapar(item.quantidade)} ${escapar(item.unidade)}`];
  const referencia = referenciaDoItem(item);
  if (referencia) linhas.push(`_${escapar(referencia)}_`);
  if (item.observacao) linhas.push(`> ${escapar(item.observacao)}`);
  return linhas.join('\n');
}

// ── Modal de revisão ─────────────────────────────────────────
const valorOpcaoProduto = (o, idx) => String(o.produto.codigo_omie ?? `idx:${idx}`);

function montarViewRevisao(item, ctx, { mostrarFormCadastro = false, selecionado } = {}) {
  const opcoes = item.opcoes_similares || [];
  const semOpcoes = opcoes.length === 0;
  const blocks = [secao(formatarItemSolicitado(item))];

  if (item.catalogo_indisponivel) {
    blocks.push(secao('⚠️ _Catálogo do Omie indisponível no momento — feche e tente novamente para ver sugestões._'));
  }

  if (semOpcoes) {
    blocks.push(secao('_Nenhum produto similar encontrado — preencha os dados abaixo para cadastrar._'));
  } else {
    const radioOpcoes = [
      ...opcoes.map((o, idx) => opcao(`${o.produto.descricao} (${o.produto.codigo}) — ${o.similaridade}%`, valorOpcaoProduto(o, idx))),
      opcao('🆕 Nenhum dos acima — cadastrar produto novo', VALOR_PRODUTO_NOVO),
    ];
    const inicial = radioOpcoes.find(o => o.value === selecionado);
    blocks.push({
      type: 'input',
      block_id: 'escolha_produto',
      dispatch_action: true, // dispara block_actions ao selecionar (revela o formulário de cadastro)
      label: plain('Selecione o produto correspondente'),
      element: {
        type: 'radio_buttons',
        action_id: 'escolha_radio',
        options: radioOpcoes,
        ...(inicial ? { initial_option: inicial } : {}),
      },
    });
  }

  if (mostrarFormCadastro || semOpcoes) {
    const origemNcm = item.ncm_origem === 'historico_omie' ? 'histórico Omie' : 'tabela local';
    const unidade = UNIDADES.includes(item.unidade) ? item.unidade : null;
    blocks.push(
      divisor(),
      secao('*Dados para cadastro do produto novo*'),
      inputTexto('descricao_cadastro', 'Descrição padronizada para o Omie', { initial: item.descricao }),
      inputTexto('ncm_cadastro', 'NCM', {
        initial: item.ncm_sugerido,
        placeholder: 'Ex: 84821010',
        optional: true,
        hint: item.ncm_descricao ? `Sugestão (${origemNcm}): ${item.ncm_descricao}` : undefined,
      }),
      {
        type: 'input',
        block_id: 'unidade_cadastro',
        label: plain('Unidade'),
        element: {
          type: 'static_select',
          action_id: 'valor',
          placeholder: plain('Selecione'),
          options: UNIDADES.map(u => opcao(u, u)),
          ...(unidade ? { initial_option: opcao(unidade, unidade) } : {}),
        },
      },
      inputTexto('observacao_cadastro', 'Observação (opcional)', { multiline: true, optional: true }),
    );
  }

  return modal({ callbackId: 'modal_revisao_submit', titulo: 'Revisar item', submit: 'Confirmar', metadata: ctx, blocks });
}

// ── Cotação ──────────────────────────────────────────────────
const MAX_ITENS_COTACAO = LIMITES.BLOCOS_MODAL - 2;
const metadataCotacao = (estado) => ({ chave: estado.chave, channel: estado.channel });
const linhaItemPreco = (i) => `• ${escapar(i.descricao)} — ${i.quantidade} ${escapar(i.unidade)} | ${moeda(i.preco_unitario)} un`;

function montarViewPrecos(estado) {
  return modal({
    callbackId: 'modal_precos_submit',
    titulo: 'Cotação — Preços',
    submit: 'Próximo',
    close: 'Cancelar',
    metadata: metadataCotacao(estado),
    blocks: [
      secao(`*Requisição:* ${escapar(estado.id_requisicao)}\nPreencha o preço unitário de cada item:`),
      divisor(),
      ...estado.itens.map(item => inputTexto(`preco_${item.id_item}`, `${item.descricao} — ${item.quantidade} ${item.unidade}`, { placeholder: 'Ex: 25,90' })),
    ],
  });
}

function blocosGrupos(estado, { comBotaoEditar = false } = {}) {
  const blocks = [];
  estado.grupos.forEach((grupo, idx) => {
    const nome = escapar(grupo.fornecedor.nome_fantasia || grupo.fornecedor.razao_social);
    const texto = `*Pedido ${idx + 1}:* ${nome}\n*Prazo:* ${grupo.prazo} dias | *Cond:* ${escapar(grupo.condicao_descricao)}\n${grupo.itens.map(linhaItemPreco).join('\n')}`;
    blocks.push(secao(texto, comBotaoEditar ? {
      accessory: {
        type: 'button',
        text: plain('✏️ Editar'),
        value: JSON.stringify({ chave: estado.chave, grupo_idx: idx }),
        action_id: 'editar_grupo_fornecedor',
      },
    } : {}));
  });
  return blocks;
}

// Modal 2 — seleciona quais itens pendentes vão para o mesmo fornecedor.
// Checkboxes aceitam no máximo 10 opções, então os itens são divididos em
// vários grupos de checkbox.
function montarViewFornecedores(estado) {
  const pendentes = estado.itens_pendentes;
  const blocks = [secao(`*Requisição:* ${escapar(estado.id_requisicao)}\nSelecione os itens que serão comprados do mesmo fornecedor:`)];

  if (estado.grupos.length > 0) {
    blocks.push(divisor(), secao('*✅ Fornecedores já definidos:*'), ...blocosGrupos(estado));
  }

  if (pendentes.length > 0) {
    blocks.push(divisor());
    for (let i = 0; i < pendentes.length; i += LIMITES.OPCOES_CHECKBOX) {
      const lote = pendentes.slice(i, i + LIMITES.OPCOES_CHECKBOX);
      blocks.push({
        type: 'input',
        block_id: `itens_sel_${i / LIMITES.OPCOES_CHECKBOX}`,
        optional: true, // a validação de "ao menos um" é feita no submit, somando todos os grupos
        label: plain(i === 0 ? 'Itens para este fornecedor:' : 'Mais itens:'),
        element: {
          type: 'checkboxes',
          action_id: 'selecao',
          options: lote.map(item => opcao(item.descricao, item.id_item, `${item.quantidade} ${item.unidade} · ${moeda(item.preco_unitario)} un`)),
        },
      });
    }
  }

  return modal({
    callbackId: 'modal2_definir_fornecedor',
    titulo: 'Cotação — Fornecedores',
    submit: pendentes.length === 0 ? 'Revisar pedidos' : 'Definir Fornecedor →',
    close: 'Cancelar',
    metadata: metadataCotacao(estado),
    blocks,
  });
}

// Modal de fornecedor — usado para definir um grupo novo e para editar um existente
function montarViewDefinirFornecedor(estado, grupoAnterior = null) {
  const resumo = estado.em_atribuicao.map(i => `• ${escapar(i.descricao)} — ${i.quantidade} ${escapar(i.unidade)}`).join('\n');
  return modal({
    callbackId: 'modal_fornecedor_submit',
    titulo: grupoAnterior ? 'Editar Fornecedor' : 'Definir Fornecedor',
    submit: 'Confirmar',
    close: 'Cancelar',
    metadata: metadataCotacao(estado),
    blocks: [
      secao(`*Itens selecionados:*\n${resumo}`),
      divisor(),
      inputTexto('busca_fornecedor', 'Fornecedor', {
        initial: grupoAnterior?.fornecedor?.nome_fantasia,
        placeholder: 'Ex: CLD Maquinas, RTE Distribuidora...',
        hint: 'Digite o nome (ou parte dele). Se houver mais de um resultado, você será avisado.',
      }),
      inputTexto('prazo_entrega', 'Prazo de entrega (dias)', { initial: grupoAnterior?.prazo, placeholder: 'Ex: 7' }),
      inputTexto('condicao_pagamento', 'Condição de pagamento', { initial: grupoAnterior?.condicao_descricao, placeholder: 'Ex: À vista, 30 dias, 30/60/90 dias' }),
      inputTexto('obs_fornecedor', 'Observação (opcional)', { initial: grupoAnterior?.obs, multiline: true, optional: true }),
    ],
  });
}

function montarViewRevisaoFinal(estado) {
  return modal({
    callbackId: 'modal_revisao_final_submit',
    titulo: 'Revisão Final',
    submit: '🛒 Criar Pedidos no Omie',
    close: 'Cancelar',
    metadata: metadataCotacao(estado),
    blocks: [
      secao(`*Revisão da Cotação — ${escapar(estado.id_requisicao)}*\nConfira os pedidos abaixo antes de criar no Omie:`),
      divisor(),
      ...blocosGrupos(estado, { comBotaoEditar: true }),
      divisor(),
      { type: 'actions', elements: [{ type: 'button', text: plain('← Voltar'), value: estado.chave, action_id: 'voltar_ao_modal2' }] },
    ],
  });
}

// Converte "25,90", "1.234,56", "R$ 10" ou "10.5" em número; NaN se inválido
function parsePreco(bruto) {
  let s = String(bruto || '').trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

module.exports = {
  LIMITES,
  VALOR_PRODUTO_NOVO,
  MAX_ITENS_COTACAO,
  limitar,
  escapar,
  plain,
  secao,
  divisor,
  moeda,
  viewCarregando,
  viewAviso,
  lerMetadata,
  formatarItemSolicitado,
  montarViewRevisao,
  montarViewPrecos,
  montarViewFornecedores,
  montarViewDefinirFornecedor,
  montarViewRevisaoFinal,
  parsePreco,
};
