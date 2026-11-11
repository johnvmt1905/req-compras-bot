// Normaliza descrições antes da busca por similaridade:
// minúsculas, sem acentos, abreviações expandidas e espaços colapsados.

const ABREVIACOES = {
  rolto: 'rolamento',
  rolt:  'rolamento',
  corr:  'correia',
  mang:  'mangueira',
  hidr:  'hidraulico',
  lub:   'lubrificante',
  filt:  'filtro',
  par:   'parafuso',
  ved:   'vedacao',
};

function removerAcentos(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizar(descricao) {
  if (!descricao) return '';

  return removerAcentos(String(descricao).toLowerCase())
    .replace(/[-_]/g, ' ')                       // 6205-2RS → 6205 2rs
    .split(/\s+/)
    .map(p => ABREVIACOES[p.replace(/\.$/, '')] || p) // "corr." e "corr" → correia
    .join(' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { normalizar, removerAcentos };
