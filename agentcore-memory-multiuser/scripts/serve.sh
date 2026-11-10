#!/usr/bin/env bash
# Start the local backend (FastAPI + the single-page UI).
#
#   scripts/serve.sh            # foreground on http://127.0.0.1:8765
#   scripts/serve.sh --daemon   # detach; logs in runs/backend.log
#   PORT=8080 scripts/serve.sh
#
# Keep HOST at 127.0.0.1. The server speaks plain HTTP and receives ID tokens; binding
# other interfaces exposes them, and an API backed by your AWS credentials, to the network.
#
# Credentials: the backend's own identity comes from AWS_PROFILE or the default credential
# chain. It uses that identity only to assume the application role that infra/setup.py
# created, once per signed-in user, with the session tag userId=<sub> (see
# backend/aws_sessions.py and README, "Run the application").
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .venv/bin/activate ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi
mkdir -p runs

PORT="${PORT:-8765}"
HOST="${HOST:-127.0.0.1}"
if [[ "${1:-}" == "--daemon" ]]; then
  setsid nohup uvicorn app:app --app-dir backend --host "$HOST" --port "$PORT" --log-level info \
    > runs/backend.log 2>&1 < /dev/null &
  echo "backend pid $! on http://$HOST:$PORT (log: runs/backend.log)"
else
  exec uvicorn app:app --app-dir backend --host "$HOST" --port "$PORT" --log-level info
fi
