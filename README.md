# GZero — Backend Requisição de Compras

## Pré-requisitos
- Node.js v20+
- Conta no Slack com app configurado
- ngrok (para testes locais)

## Instalação

```bash
cd gzero-backend
npm install
cp .env.example .env
# Preencha o .env com suas credenciais
```

## Configuração

### 1. Variáveis de ambiente (.env)
```
SLACK_BOT_TOKEN       → Bot User OAuth Token (xoxb-...)
SLACK_SIGNING_SECRET  → Signing Secret (Basic Information)
SHEETS_SPREADSHEET_ID → ID da planilha (URL do Sheets)
GOOGLE_APPLICATION_CREDENTIALS → ./credentials.json
PORT                  → 3000 (padrão)
```

### 2. Google Sheets API (Service Account)
1. Acesse console.cloud.google.com
2. Crie um projeto ou use um existente
3. Ative a API: "Google Sheets API"
4. Crie uma Service Account (IAM → Service Accounts)
5. Gere uma chave JSON e salve como `credentials.json` na raiz do projeto
6. Compartilhe a planilha com o e-mail da Service Account (Editor)

### 3. Slack — Interactivity URL
1. Suba o servidor localmente
2. Abra um túnel com ngrok: `ngrok http 3000`
3. Copie a URL pública (ex: https://abc123.ngrok.io)
4. No painel do app Slack:
   - Interactivity & Shortcuts → Request URL: `https://abc123.ngrok.io/slack/events`
5. Salve e reinstale o app no workspace

### 4. Apps Script — URL do Backend
Na aba Configurações da planilha, preencha:
- URL do Backend: `http://localhost:3000` (testes) ou URL do servidor em produção

---

## Rodando

```bash
# Desenvolvimento (com hot reload)
npm run dev

# Produção
npm start
```

## Testando sem Slack

Para testar só o endpoint com curl:

```bash
curl -X POST http://localhost:3000/requisicao \
  -H "Content-Type: application/json" \
  -d '{
    "id_requisicao": "REQ-20260608-TEST",
    "itens_at": [{
      "id_item": "AT-4",
      "area": "AT",
      "solicitante": "Cleison",
      "descricao": "rolamento 6205 2rs",
      "quantidade": 2,
      "unidade": "PC",
      "num_tarefa": "T-001",
      "observacao": ""
    }],
    "itens_subconjunto": [],
    "config": {
      "Threshold automático": "85",
      "Threshold aprovação": "50",
      "ID do Canal": "#compras",
      "ID do Comprador": "",
      "Nome do Comprador": "Luciano"
    }
  }'
```

## Testes

```bash
npm test
```

Roda testes unitários e uma simulação do fluxo completo no Slack (revisão → cadastro → cotação → pedido) com Slack, Omie e Sheets substituídos por fakes — não toca em nenhum sistema real.

## Estrutura do projeto

```
src/
├── server.js            → Express: /health, /requisicao, /requisicao-teste
├── config/
│   └── environment.js   → canal/planilha por ambiente + validação do .env
├── utils/
│   └── cache.js         → TtlMap, cache assíncrono, lock, concorrência
├── services/
│   ├── normalizer.js    → normalização de descrições
│   ├── matcher.js       → similaridade (fuse.js) com índice do catálogo em cache
│   ├── ncmService.js    → sugestão de NCM pela tabela local (src/data/ncm.json)
│   ├── omieService.js   → API Omie (catálogo, fornecedores, produto, pedido)
│   └── sheets.js        → Google Sheets (abas Itens e Histórico)
└── slack/
    ├── bot.js           → ponto de entrada (registra os handlers)
    ├── app.js           → instância do Bolt e caches em memória
    ├── blocos.js        → Block Kit e montagem dos modais
    ├── mensagens.js     → envio/edição da mensagem da requisição
    ├── revisao.js       → fluxo de revisão de itens
    └── cotacao.js       → fluxo de cotação e pedidos no Omie
```

## Segurança do endpoint (opcional)
Se `REQUISICAO_TOKEN` estiver no `.env`, o Apps Script precisa enviar o header
`x-requisicao-token` com o mesmo valor:

```js
UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
  headers: { 'x-requisicao-token': TOKEN }, payload: JSON.stringify(dados) });
```

Sem a variável, o endpoint continua aberto como antes.

## Próximos passos
- [ ] Definir `REQUISICAO_TOKEN` e enviar o header no Apps Script
- [ ] Mapear a condição de pagamento para o `cCodParc` do Omie (hoje vai fixo 999 + texto na observação)
- [ ] Deploy em servidor (Railway / Render) usando `GOOGLE_CREDENTIALS_JSON`

