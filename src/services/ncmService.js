const fs = require('fs');
const path = require('path');
const { normalizar } = require('./normalizer');

// ── Caminho do arquivo baixado da Receita Federal/Siscomex ──
const NCM_PATH = path.join(__dirname, '..', 'data', 'ncm.json');

let indiceNcm = null; // carregado uma vez, mantido em memória

// Corrige problema comum de encoding (UTF-8 lido como Latin-1)
// Ex: "acessÃ³rios" -> "acessórios"
function corrigirEncoding(texto) {
  if (!texto) return texto;
  try {
    let corrigido = Buffer.from(texto, 'latin1').toString('utf8');
    // Remove resíduos de non-breaking space e caracteres de controle/replacement
    // que sobram em exportações malformadas (ex: "30Â mm" -> "30 mm")
    corrigido = corrigido
      .replace(/\u00A0/g, ' ')   // non-breaking space
      .replace(/\uFFFD/g, '')    // replacement character
      .replace(/[\u0080-\u009F]/g, '') // controles C1 remanescentes
      .replace(/\s{2,}/g, ' ')   // colapsa espaços duplos resultantes
      .trim();
    return corrigido;
  } catch {
    return texto;
  }
}

// Normaliza o formato do código: remove pontos, mantém só dígitos
// "9031.90.10" -> "90319010"
function normalizarCodigo(codigo) {
  return String(codigo).replace(/\D/g, '');
}

// Carrega e prepara o índice de busca a partir do ncm.json
function carregarTabela() {
  if (indiceNcm) return indiceNcm;

  if (!fs.existsSync(NCM_PATH)) {
    console.warn(`[NCM] Arquivo não encontrado em ${NCM_PATH} — sugestão de NCM local desativada.`);
    indiceNcm = [];
    return indiceNcm;
  }

  const raw = fs.readFileSync(NCM_PATH, 'utf8');
  const json = JSON.parse(raw);

  // O arquivo do Siscomex vem como objeto com metadados e o array
  // real dentro da chave "Nomenclaturas" — não como array no nível raiz.
  const dados = Array.isArray(json) ? json : (json.Nomenclaturas || []);

  if (dados.length === 0) {
    console.warn('[NCM] Nenhum registro encontrado — verifique a estrutura do arquivo.');
    indiceNcm = [];
    return indiceNcm;
  }

  indiceNcm = dados
    // Mantém só códigos completos (8 dígitos), que são os realmente usáveis em NF-e/Omie.
    // Códigos parciais (ex: "90.32", "9032.10") são categorias intermediárias da hierarquia.
    .filter(item => normalizarCodigo(item.Codigo).length === 8)
    .map(item => {
      const descricaoCorrigida = corrigirEncoding(item.Descricao);
      return {
        codigo: normalizarCodigo(item.Codigo),
        descricao: descricaoCorrigida,
        descricaoNorm: normalizar(descricaoCorrigida),
      };
    });

  console.log(`[NCM] Tabela local carregada: ${indiceNcm.length} códigos de 8 dígitos.`);
  return indiceNcm;
}

// Busca por palavras-chave da descrição normalizada.
// Estratégia simples: conta quantas palavras da descrição do item
// aparecem na descrição de cada código NCM, prioriza o de maior interseção.
function buscarPorDescricao(descricaoNormalizada, limite = 3) {
  const tabela = carregarTabela();
  if (tabela.length === 0) return [];

  const palavrasBusca = descricaoNormalizada
    .split(' ')
    .filter(p => p.length >= 3); // ignora palavras muito curtas (preposições, etc.)

  if (palavrasBusca.length === 0) return [];

  const candidatos = tabela.map(item => {
    let pontos = 0;
    palavrasBusca.forEach(palavra => {
      if (item.descricaoNorm.includes(palavra)) pontos += 1;
    });
    return { ...item, pontos };
  });

  return candidatos
    .filter(c => c.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, limite);
}

// Sugere um único NCM para uma descrição — usado quando o histórico Omie não encontrou nada
function sugerirNcm(descricaoNormalizada) {
  const resultados = buscarPorDescricao(descricaoNormalizada, 1);
  if (resultados.length === 0) {
    return { ncm: null, origem: null, descricaoNcm: null };
  }
  return {
    ncm: resultados[0].codigo,
    origem: 'tabela_local',
    descricaoNcm: resultados[0].descricao,
  };
}

module.exports = { sugerirNcm, buscarPorDescricao, carregarTabela };