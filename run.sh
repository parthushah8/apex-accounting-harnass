#!/bin/zsh
cd "$(dirname "$0")"
PORT="${APEX_PORT:-8765}"
PIDS=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
if [[ -n "$PIDS" ]]; then
  echo "freeing :$PORT ($PIDS)"
  kill $PIDS 2>/dev/null || true
  sleep 0.4
fi
exec .venv/bin/python server.py
