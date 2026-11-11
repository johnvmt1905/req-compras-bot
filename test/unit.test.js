const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizar } = require('../src/services/normalizer');
const { TtlMap, criarCacheAssincrono, criarLock, mapearComConcorrencia, esperar } = require('../src/utils/cache');
const { localizarLinhaItem } = require('../src/services/sheets');
const { gerarCodigoIntegracaoPedido } = require('../src/services/omieService');

test('normalizar: acentos, separadores e abreviações', () => {
  assert.equal(normalizar('Rolt. 6205-2RS  Óleo'), 'rolamento 6205 2rs oleo');
  assert.equal(normalizar('Mang. hidr 1/2"'), 'mangueira hidraulico 1 2');
  assert.equal(normalizar(null), '');
});

test('TtlMap expira entradas e respeita o tamanho máximo', async () => {
  const m = new TtlMap({ ttlMs: 20, max: 2 });
  m.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(m.get('a'), undefined); // descartado por tamanho
  assert.equal(m.get('c'), 3);
  await esperar(30);
  assert.equal(m.get('c'), undefined); // expirado
});

test('criarCacheAssincrono: chamadas simultâneas compartilham o carregamento', async () => {
  let chamadas = 0;
  const cache = criarCacheAssincrono(async () => { chamadas++; await esperar(10); return [chamadas]; }, 1000);
  const [a, b] = await Promise.all([cache.obter(), cache.obter()]);
  assert.equal(chamadas, 1);
  assert.equal(a, b);
  cache.invalidar();
  await cache.obter();
  assert.equal(chamadas, 2);
});

test('criarLock serializa tarefas da mesma chave', async () => {
  const comLock = criarLock();
  const ordem = [];
  await Promise.all([
    comLock('x', async () => { await esperar(20); ordem.push(1); }),
    comLock('x', async () => { ordem.push(2); }),
  ]);
  assert.deepEqual(ordem, [1, 2]);
  await assert.rejects(comLock('x', async () => { throw new Error('falhou'); }));
  assert.equal(await comLock('x', async () => 'segue'), 'segue'); // falha anterior não trava a fila
});

test('mapearComConcorrencia preserva ordem', async () => {
  const r = await mapearComConcorrencia([3, 1, 2], 2, async (n) => { await esperar(n * 5); return n * 10; });
  assert.deepEqual(r, [30, 10, 20]);
});

test('localizarLinhaItem diferencia id_item repetido entre requisições', () => {
  const rows = [['ID'], ['AT-4', 'REQ-1'], ['AT-4', 'REQ-2']];
  assert.equal(localizarLinhaItem(rows, 'AT-4', 'REQ-1'), 1);
  assert.equal(localizarLinhaItem(rows, 'AT-4', 'REQ-2'), 2);
  assert.equal(localizarLinhaItem(rows, 'AT-4', null), 2); // sem requisição: mais recente
  assert.equal(localizarLinhaItem(rows, 'AT-9', null), -1);
});

test('código de integração do pedido respeita 20 caracteres', () => {
  const curto = gerarCodigoIntegracaoPedido('REQ-1', 0);
  assert.equal(curto, 'REQ-1-G1');
  const longo = gerarCodigoIntegracaoPedido('REQ-20260608-TESTE-LONGO', 2, 'ab12');
  assert.ok(longo.length <= 20);
  assert.notEqual(longo, gerarCodigoIntegracaoPedido('REQ-20260608-TESTE-LONGO', 2, 'cd34'));
});
