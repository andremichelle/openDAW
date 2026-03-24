#!/bin/bash
set -euo pipefail

: "${SSH_SERVER:?SSH_SERVER is not set}"
: "${SSH_PASSWORD:?SSH_PASSWORD is not set}"
REMOTE_DIR="/opt/opendaw/yjs-server"

export SSHPASS="$SSH_PASSWORD"
SSH_CMD="ssh -p 22 -o PreferredAuthentications=keyboard-interactive,password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new"

echo "Syncing yjs-server files..."
sshpass -e rsync -avz --delete \
  -e "$SSH_CMD" \
  packages/server/yjs-server/ \
  "$SSH_SERVER:$REMOTE_DIR/"

echo "Installing dependencies and restarting..."
sshpass -e $SSH_CMD "$SSH_SERVER" << 'EOF'
  cd /opt/opendaw/yjs-server
  npm install --production
  systemctl restart opendaw-yjs
  systemctl status opendaw-yjs --no-pager
EOF

echo "yjs-server deployed and restarted"
