#!/bin/bash
set -euo pipefail

: "${SSH_SERVER:?SSH_SERVER is not set}"
REMOTE_DIR="/opt/agent-relay"

echo "Syncing agent-relay files..."
rsync -avz --delete \
  --exclude='data/' \
  --exclude='node_modules/' \
  --exclude='test/' \
  -e "ssh -o StrictHostKeyChecking=accept-new" \
  packages/server/agent-relay/ \
  "$SSH_SERVER:$REMOTE_DIR/"

echo "Installing the systemd unit..."
rsync -avz \
  -e "ssh -o StrictHostKeyChecking=accept-new" \
  deploy/opendaw-agent.service \
  "$SSH_SERVER:/etc/systemd/system/opendaw-agent.service"

echo "Installing dependencies and restarting..."
ssh -o StrictHostKeyChecking=accept-new "$SSH_SERVER" << EOF
  set -e
  cd $REMOTE_DIR
  mkdir -p data
  chmod 700 data
  npm install --omit=dev
  systemctl daemon-reload
  systemctl enable opendaw-agent
  systemctl restart opendaw-agent
  systemctl status opendaw-agent --no-pager
EOF

echo "agent-relay deployed and restarted"
