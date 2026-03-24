#!/bin/bash
set -euo pipefail

: "${SSH_SERVER:?SSH_SERVER is not set}"
REMOTE_DIR="/opt/yjs-server"

echo "Syncing yjs-server files..."
rsync -avz --delete \
  -e "ssh -o StrictHostKeyChecking=accept-new" \
  packages/server/yjs-server/ \
  "$SSH_SERVER:$REMOTE_DIR/"

echo "Installing dependencies and restarting..."
ssh -o StrictHostKeyChecking=accept-new "$SSH_SERVER" << EOF
  cd $REMOTE_DIR
  npm install --omit=dev
  systemctl restart opendaw-yjs
  systemctl status opendaw-yjs --no-pager
EOF

echo "yjs-server deployed and restarted"
