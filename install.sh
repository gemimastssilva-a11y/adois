#!/bin/bash
# A Dois — instalação completa na VPS
set -e
cd "$(dirname "$0")"

echo "== A Dois: instalando =="

# 1. Node.js (se não tiver)
if ! command -v node >/dev/null 2>&1; then
  echo "-- instalando Node.js..."
  (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null 2>&1) || apt-get install -y nodejs npm >/dev/null 2>&1
fi
node --version

# 2. .env com credenciais do app Meta "A Dois"
if [ ! -f .env ]; then
  cat > .env <<'EOF'
META_APP_ID=1831264568294810
META_APP_SECRET=a5a0a5d34032b7c4362c6236efc1462c
VERIFY_TOKEN=adois-vinculo-2026-7f3a9b
OAUTH_REDIRECT_URI=http://localhost:3007/oauth/callback
PORT=3007
EOF
  chmod 600 .env
  echo "-- .env criado"
fi

# 3. inicia
export $(grep -v '^#' .env | xargs)
mkdir -p logs
pkill -f "node server.js" 2>/dev/null || true
sleep 1
nohup node server.js > logs/adois.log 2>&1 &
echo $! > logs/adois.pid
sleep 2

echo "== status =="
cat logs/adois.log
echo ""
curl -s http://localhost:${PORT:-3007}/health
echo ""
echo ""
echo "OK — A Dois backend rodando (PID $(cat logs/adois.pid), porta ${PORT:-3007})"
echo "Logs: $(pwd)/logs/adois.log | Parar: kill \$(cat logs/adois.pid)"
