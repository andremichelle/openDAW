#!/bin/bash
set -euo pipefail

: "${SSH_SERVER:?SSH_SERVER is not set}"
: "${SSH_PASSWORD:?SSH_PASSWORD is not set}"
REMOTE_DIR="/opt/opendaw/yjs-server"

echo "Syncing yjs-server files..."
sshpass -p "$SSH_PASSWORD" rsync -avz --delete \
  -e ssh \
  packages/server/yjs-server/ \
  "$SSH_SERVER:$REMOTE_DIR/"

echo "Installing dependencies and restarting..."
sshpass -p "$SSH_PASSWORD" ssh "$SSH_SERVER" << 'EOF'
  cd /opt/opendaw/yjs-server
  npm install --production
  systemctl restart opendaw-yjs
  systemctl status opendaw-yjs --no-pager
EOF

echo "yjs-server deployed and restarted"
