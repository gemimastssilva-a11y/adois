# A Dois — Backend (produção)

Backend omnichannel do SaaS A Dois: webhooks da Meta (WhatsApp/Instagram/Facebook), IA de sugestões (Gottman/Chapman/Perel), assinaturas Stripe, OAuth BYO.

## Instalação na VPS (1 comando)

```bash
bash <(curl -sL https://raw.githubusercontent.com/gemimastssilva-a11y/adois/main/install.sh)
```

Ou manual:

```bash
apt-get install -y curl git >/dev/null 2>&1
git clone https://github.com/gemimastssilva-a11y/adois.git /root/adois
cd /root/adois && bash install.sh
```

## Variáveis de ambiente (.env)

Criado automaticamente pelo install.sh com as credenciais Meta do app "A Dois".

```
PORT=3007
META_APP_ID=...
META_APP_SECRET=...
VERIFY_TOKEN=...
OAUTH_REDIRECT_URI=https://SEU-DOMINIO/oauth/callback
LLM_API_KEY=...        # opcional (fallback: regras)
STRIPE_SECRET_KEY=...  # opcional
STRIPE_WEBHOOK_SECRET=... # opcional
```

## Endpoints

| Método | Rota | Função |
|---|---|---|
| GET | /webhook | verificação da Meta (hub.challenge) |
| POST | /webhook | mensagens recebidas (valida X-Hub-Signature-256) |
| POST | /sugerir | gera 3 sugestões (IA ou fallback) |
| GET | /planos | limites freemium |
| POST | /assinar | checkout Stripe |
| POST | /webhook-stripe | eventos de assinatura (HMAC validado) |
| GET | /oauth/whatsapp | inicia OAuth BYO |
| GET | /oauth/callback | troca code por token |
| GET | /health | status + métricas |

## Segurança

- NENHUM endpoint envia mensagens — o SaaS só analisa e sugere (decisão de arquitetura).
- Webhook Meta valida X-Hub-Signature-256 (HMAC-SHA256 com META_APP_SECRET).
- Webhook Stripe valida assinatura HMAC.
- Tokens OAuth: produção → tabela canais no Supabase, criptografados AES-256.
