# Deploy: yjs-server via GitHub Actions

## Goal

Automate deployment of `packages/server/yjs-server` to the Hetzner VPS. After deploy, everything works exactly as it does now — same `server.js`, same port 443, same Let's Encrypt certs, same Yjs sync + signaling behavior. The only change is how the code gets there and how the process is managed.

## Current State

- **Frontend** (`opendaw.studio`): Deployed via GitHub Actions → SFTP (`deploy/run.ts`).
- **yjs-server** (`live.opendaw.studio:443`): No automated deployment. Manual SSH: `ssh -p 22 root@159.69.124.128`.
- **Server OS**: Linux (Hetzner VPS at 159.69.124.128).

---

## Steps

### 1. Set up systemd service on the server

SSH into `root@159.69.124.128` and create `/etc/systemd/system/opendaw-yjs.service`:

```ini
[Unit]
Description=openDAW Yjs Collaboration Server
After=network.target

[Service]
Type=simple
User=opendaw
WorkingDirectory=/opt/opendaw/yjs-server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=443

[Install]
WantedBy=multi-user.target
```

**Auto-restart behavior**:
- `Restart=always`: systemd restarts the process if it crashes, is killed, or exits for any reason.
- `RestartSec=5`: waits 5 seconds before restarting (avoids rapid crash loops).
- `WantedBy=multi-user.target`: starts automatically on VPS boot/reboot.

Enable and start:
```bash
systemctl daemon-reload
systemctl enable opendaw-yjs   # start on boot
systemctl start opendaw-yjs    # start now
```

### 2. First-time server setup

Before the first automated deploy, manually set up the target directory and move the currently running server code there:

```bash
mkdir -p /opt/opendaw/yjs-server
cp -r /path/to/current/yjs-server/* /opt/opendaw/yjs-server/
cd /opt/opendaw/yjs-server
npm install --production
```

Verify it works: `systemctl start opendaw-yjs && systemctl status opendaw-yjs`

Then stop whatever process is currently running the server (likely a manual `node server.js` or screen/tmux session).

### 3. Set up SSH key auth for GitHub Actions

Generate a key pair (on your machine or in GitHub):
```bash
ssh-keygen -t ed25519 -f opendaw-deploy -N ""
```

On the server:
```bash
# Add the public key
cat opendaw-deploy.pub >> /root/.ssh/authorized_keys
```

In GitHub repo → Settings → Secrets and variables → Actions → add:
- `SSH_PRIVATE_KEY`: contents of `opendaw-deploy` (private key)
- `SSH_SERVER`: `root@159.69.124.128` (user@host, not hardcoded in scripts)

### 4. Add deploy script

Create `deploy/deploy-yjs.sh`:

```bash
#!/bin/bash
set -euo pipefail

SERVER="root@159.69.124.128"
REMOTE_DIR="/opt/opendaw/yjs-server"

rsync -avz --delete \
  packages/server/yjs-server/ \
  "$SERVER:$REMOTE_DIR/"

ssh "$SERVER" << 'EOF'
  cd /opt/opendaw/yjs-server
  npm install --production
  systemctl restart opendaw-yjs
  systemctl status opendaw-yjs --no-pager
EOF

echo "yjs-server deployed and restarted"
```

### 5. Add deploy job to `deploy.yml`

Alongside the existing `build-and-deploy` job:

```yaml
deploy-yjs-server:
  runs-on: ubuntu-latest
  environment: production
  needs: build-and-deploy
  steps:
    - uses: actions/checkout@v5
    - name: Deploy yjs-server
      env:
        SSH_PRIVATE_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
      run: |
        mkdir -p ~/.ssh
        echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
        chmod 600 ~/.ssh/id_rsa
        ssh-keyscan -H 159.69.124.128 >> ~/.ssh/known_hosts
        bash deploy/deploy-yjs.sh
```

### 6. Add a manual restart workflow

For cases where you just need to restart the server without deploying new code (e.g., after a cert renewal or if you notice it's down):

Create `.github/workflows/restart-yjs.yml`:

```yaml
name: Restart yjs-server

on:
  workflow_dispatch:

jobs:
  restart:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Restart yjs-server via SSH
        env:
          SSH_PRIVATE_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
        run: |
          mkdir -p ~/.ssh
          echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa
          ssh-keyscan -H 159.69.124.128 >> ~/.ssh/known_hosts
          ssh root@159.69.124.128 "systemctl restart opendaw-yjs && systemctl status opendaw-yjs --no-pager"
```

This is triggered manually from the GitHub Actions tab ("Run workflow" button).

---

## What Happens on Failure

| Scenario | What happens |
|----------|-------------|
| `server.js` crashes | systemd restarts it within 5 seconds (`Restart=always`) |
| VPS reboots | systemd starts it automatically on boot (`WantedBy=multi-user.target`) |
| VPS is down entirely | Nothing — Hetzner needs to bring it back, then systemd restarts the service |
| Deploy fails mid-rsync | Old code still running (systemd hasn't restarted yet). Re-run the workflow. |
| `npm install` fails on server | Deploy script exits with error (set -e). Old process was already stopped by rsync. Manual SSH to fix. |
| Want to restart manually | Use the restart workflow above, or SSH in and `systemctl restart opendaw-yjs` |

---

## coturn (TURN relay) — for later, when P2P asset exchange ships

Install on the same VPS:

```bash
apt install coturn
```

Configure `/etc/turnserver.conf`:
```
listening-port=3478
tls-listening-port=5349
realm=live.opendaw.studio
server-name=live.opendaw.studio
cert=/etc/letsencrypt/live/live.opendaw.studio/fullchain.pem
pkey=/etc/letsencrypt/live/live.opendaw.studio/privkey.pem
user=opendaw:<password>
no-cli
```

```bash
systemctl enable coturn
systemctl start coturn
```

---

## Let's Encrypt Certificate Renewal

Verify certbot auto-renewal is set up. Add post-hooks to restart services when certs are renewed:

```bash
certbot certificates
# Add to /etc/letsencrypt/renewal-hooks/post/restart-services.sh:
#!/bin/bash
systemctl restart opendaw-yjs
# systemctl restart coturn  # uncomment when coturn is installed
```

```bash
chmod +x /etc/letsencrypt/renewal-hooks/post/restart-services.sh
```
