# GZero — Backend Requisição de Compras

## Pré-requisitos
- Node.js v22+
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

## Estrutura do projeto

```
src/
├── server.js          → Express + endpoint /requisicao
├── slack/
│   └── bot.js         → Bolt, mensagens e modais
├── services/
│   ├── normalizer.js  → Normalização de descrição
│   ├── matcher.js     → Similaridade (fuse.js)
│   └── sheets.js      → Google Sheets API
└── mock/
    └── produtos.js    → Catálogo fake para testes sem Omie
```

## Próximos passos
- [ ] Configurar Google Sheets API (credentials.json)
- [ ] Configurar ngrok e atualizar URL no Slack
- [ ] Testar fluxo completo AT → Node → Slack → modal
- [ ] Integrar Omie (substituir mock/produtos.js)
- [ ] Deploy em servidor (Railway / Render)
```
