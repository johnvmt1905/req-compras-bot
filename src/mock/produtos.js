// Catálogo mock — substitui o Omie durante os testes
// Quando integrar o Omie, esse arquivo não será mais usado

const produtos = [
  { codigo: '001', descricao: 'Rolamento 6205 2RS',         ncm: '84821010', unidade: 'PC' },
  { codigo: '002', descricao: 'Rolamento 6204 2RS',         ncm: '84821010', unidade: 'PC' },
  { codigo: '003', descricao: 'Rolamento 6206 2RS',         ncm: '84821010', unidade: 'PC' },
  { codigo: '004', descricao: 'Correia dentada 3M 300',     ncm: '40103900', unidade: 'PC' },
  { codigo: '005', descricao: 'Correia dentada 5M 450',     ncm: '40103900', unidade: 'PC' },
  { codigo: '006', descricao: 'Óleo hidráulico 46 AW',      ncm: '27101980', unidade: 'LT' },
  { codigo: '007', descricao: 'Óleo lubrificante 68',       ncm: '27101980', unidade: 'LT' },
  { codigo: '008', descricao: 'Mangueira hidráulica 1/2',   ncm: '40094100', unidade: 'M'  },
  { codigo: '009', descricao: 'Mangueira hidráulica 3/4',   ncm: '40094100', unidade: 'M'  },
  { codigo: '010', descricao: 'Filtro de ar compressor',    ncm: '84213990', unidade: 'PC' },
  { codigo: '011', descricao: 'Filtro de óleo hidráulico',  ncm: '84213990', unidade: 'PC' },
  { codigo: '012', descricao: 'Vedação oring 50x3',         ncm: '40169300', unidade: 'PC' },
  { codigo: '013', descricao: 'Vedação oring 30x2',         ncm: '40169300', unidade: 'PC' },
  { codigo: '014', descricao: 'Parafuso M8x30 sextavado',   ncm: '73181590', unidade: 'PC' },
  { codigo: '015', descricao: 'Parafuso M10x40 sextavado',  ncm: '73181590', unidade: 'PC' },
];

module.exports = produtos;
