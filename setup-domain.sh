#!/bin/zsh
set -e
LINE="127.0.0.1 apex-accounting-harness.ai"
if ! grep -q "apex-accounting-harness.ai" /etc/hosts; then
  echo "$LINE" | sudo tee -a /etc/hosts >/dev/null
  echo "added $LINE to /etc/hosts"
else
  echo "hosts already has apex-accounting-harness.ai"
fi
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder 2>/dev/null || true
echo "open http://apex-accounting-harness.ai"
