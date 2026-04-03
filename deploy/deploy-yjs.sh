#!/bin/bash
set -euo pipefail

: "${SSH_SERVER:?SSH_SERVER is not set}"
REMOTE_DIR="/opt/yjs-server"

echo "Syncing yjs-server files..."
rsync -avz --delete \
  --exclude='data/' \
  -e "ssh -o StrictHostKeyChecking=accept-new" \
  packages/server/yjs-server/ \
  "$SSH_SERVER:$REMOTE_DIR/"

echo "Installing dependencies and restarting..."
ssh -o StrictHostKeyChecking=accept-new "$SSH_SERVER" << EOF
  cd $REMOTE_DIR
  mkdir -p data
  [ -f data/rooms-count.json ] || echo '{}' > data/rooms-count.json
  [ -f data/rooms-duration.json ] || echo '{}' > data/rooms-duration.json
  systemctl stop opendaw-yjs 2>/dev/null || true
  fuser -k 443/tcp 2>/dev/null || true
  sleep 1
  npm install --omit=dev
  systemctl start opendaw-yjs
  systemctl status opendaw-yjs --no-pager
EOF

echo "yjs-server deployed and restarted"
