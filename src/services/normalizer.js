// Normaliza descrições antes da busca por similaridade
// Remove acentos, padroniza abreviações comuns, limpa espaços

const ABREVIACOES = {
  'rolto':    'rolamento',
  'rolt':     'rolamento',
  'corr':     'correia',
  'corr.':    'correia',
  'mang':     'mangueira',
  'mang.':    'mangueira',
  'hidr':     'hidraulico',
  'hidr.':    'hidraulico',
  'lub':      'lubrificante',
  'lub.':     'lubrificante',
  'filt':     'filtro',
  'filt.':    'filtro',
  'par':      'parafuso',
  'ved':      'vedacao',
  'ved.':     'vedacao',
};

function removerAcentos(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizar(descricao) {
  if (!descricao) return '';

  let texto = descricao
    .toLowerCase()
    .trim();

  // Remove acentos
  texto = removerAcentos(texto);

  // Padroniza separadores de código (6205-2RS → 6205 2rs)
  texto = texto.replace(/[-_]/g, ' ');

  // Expande abreviações
  const palavras = texto.split(/\s+/);
  const expandidas = palavras.map(p => ABREVIACOES[p] || p);
  texto = expandidas.join(' ');

  // Remove caracteres especiais exceto números e letras
  texto = texto.replace(/[^a-z0-9\s]/g, ' ');

  // Colapsa espaços múltiplos
  texto = texto.replace(/\s+/g, ' ').trim();

  return texto;
}

module.exports = { normalizar };
