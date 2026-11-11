// Utilitários de cache e concorrência usados em todo o backend.

// Map com expiração por entrada e limite de tamanho — evita vazamento de
// memória dos caches que antes cresciam indefinidamente.
class TtlMap {
  constructor({ ttlMs, max = 5000 }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.dados = new Map();
  }

  get(chave) {
    const entrada = this.dados.get(chave);
    if (!entrada) return undefined;
    if (entrada.expiraEm < Date.now()) {
      this.dados.delete(chave);
      return undefined;
    }
    return entrada.valor;
  }

  has(chave) {
    return this.get(chave) !== undefined;
  }

  set(chave, valor) {
    this.dados.delete(chave); // reinsere no fim (ordem = mais recente)
    this.dados.set(chave, { valor, expiraEm: Date.now() + this.ttlMs });
    if (this.dados.size > this.max) {
      this.dados.delete(this.dados.keys().next().value); // descarta o mais antigo
    }
    return this;
  }

  delete(chave) {
    return this.dados.delete(chave);
  }
}

// Cache assíncrono com TTL e "promise singleton": chamadas simultâneas
// aguardam o mesmo carregamento em vez de disparar várias requisições.
// O contador de versão impede que um carregamento iniciado antes de um
// invalidar() sobrescreva o cache com dados antigos.
function criarCacheAssincrono(carregar, ttlMs) {
  let valor = null;
  let carregadoEm = 0;
  let emAndamento = null;
  let versao = 0;

  async function obter(forcar = false) {
    if (!forcar && valor !== null && Date.now() - carregadoEm < ttlMs) return valor;
    if (emAndamento) return emAndamento;

    const versaoAtual = versao;
    emAndamento = (async () => {
      try {
        const resultado = await carregar();
        if (versaoAtual === versao) {
          valor = resultado;
          carregadoEm = Date.now();
        }
        return resultado;
      } finally {
        emAndamento = null;
      }
    })();
    return emAndamento;
  }

  function invalidar() {
    versao += 1;
    valor = null;
    emAndamento = null;
  }

  return { obter, invalidar };
}

// Serializa execuções por chave: duas tarefas com a mesma chave nunca
// rodam ao mesmo tempo (ex.: duas atualizações da mesma mensagem do Slack).
function criarLock() {
  const filas = new Map();
  return function comLock(chave, tarefa) {
    const anterior = filas.get(chave) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(tarefa);
    const marcador = atual.catch(() => {});
    filas.set(chave, marcador);
    marcador.then(() => {
      if (filas.get(chave) === marcador) filas.delete(chave);
    });
    return atual;
  };
}

// Executa fn sobre os itens com no máximo `limite` chamadas simultâneas,
// preservando a ordem dos resultados.
async function mapearComConcorrencia(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  async function trabalhador() {
    while (proximo < itens.length) {
      const idx = proximo++;
      resultados[idx] = await fn(itens[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, trabalhador));
  return resultados;
}

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { TtlMap, criarCacheAssincrono, criarLock, mapearComConcorrencia, esperar };
