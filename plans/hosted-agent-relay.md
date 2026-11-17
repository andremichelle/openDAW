# Hosted Agent Relay (#553)

An agent (Claude Code, Cursor, any MCP client) controls a studio through our server, no install on the user's side. The local relay (`scripts/mcp/relay.mjs`) stays for development and offline use.

## Goal

1. A user opens openDAW menu > Connect Agent..., picks "openDAW server" (default) or "Local relay".
2. The dialog shows one command with a copy button:
   `claude mcp add --transport http opendaw https://live.opendaw.studio/agent/mcp --header "Authorization: Bearer <token>"`
3. From then on every Claude Code session reaches this studio whenever it is connected.

## Security rules

1. The server generates the token (32 random bytes, base64url). A token belongs to exactly one studio.
2. An agent request is forwarded only to the studio connection that owns its token. There is no other routing, no listing, no lookup by anything else.
3. Missing or unknown token: 401. Failed attempts are rate limited per IP (10 per minute, then blocked for 10 minutes).
4. A token is valid for 30 days after it was issued. "New token" in the dialog replaces it at once, the old one stops working.
5. One studio per token. A second studio connecting with the same token replaces the first, the first gets closed with a message.
6. The studio only accepts the server's WebSocket from its own origin list (opendaw.studio, dev.opendaw.studio, localhost).
7. No content is stored or logged: no scripts, no results, no context, no API text. Logged are only counts (connections, calls, rejects).
8. TLS everywhere (`https`, `wss`).

The server is trusted. Scripts and project data pass through it unencrypted.

## Routing through live.opendaw.studio

No new domain, DNS record or certificate. The live room server (`yjs-server`) owns port 443 and the certificate, it forwards every path starting with `/agent/` to the agent relay:

1. HTTP requests and WebSocket upgrades under `/agent/` go to `127.0.0.1:8790` (HTTP proxy with `http.request`, upgrade by piping the sockets), everything else stays as it is.
2. Room names cannot contain a slash, so `/agent/` never collides with a room.
3. Agent relay down: `/agent/` answers 503, live rooms are unaffected.
4. This is the only change to `yjs-server`, done once. After that both services deploy and restart independently.

## Server (`packages/server/agent-relay`)

1. Node, plain `http` + `ws` on `127.0.0.1:8790` (TLS ends at `yjs-server`), own systemd service `opendaw-agent`, own deploy script `deploy/deploy-agent.sh`.
2. Client IP for rate limiting comes from `X-Forwarded-For`, set by the forwarding in `yjs-server` and trusted only from 127.0.0.1.
3. Studio side: `wss://live.opendaw.studio/agent/studio`
    1. First message from the studio: `{type: "hello", token?}`. Unknown or expired token, or none: the server issues a new one and answers `{type: "token", token, expires}`.
    2. Then the studio sends the API texts and the agent texts (instructions, tool descriptions), exactly as with the local relay.
4. Agent side: `https://live.opendaw.studio/agent/mcp`, MCP Streamable HTTP (POST JSON-RPC, JSON responses, no server push needed).
    1. `Authorization: Bearer <token>` on every request.
    2. `initialize`, `tools/list`, `tools/call`, `ping` like the local relay, answered from what the studio sent.
    3. Studio not connected: tools answer "The studio is not connected. Ask the user to open openDAW and connect the agent."
5. Tokens persist in a small JSON file (`data/tokens.json`, ignored by git: token hash, created, expires, and the last tools and instructions the studio sent) so a restart does not break configured agents. Only SHA-256 hashes are stored. The cached tools let `tools/list` answer while the studio is offline, the endpoint has no server push for list changes.
6. Limits: request body 1 MB, 8 pending calls per token, 60 s timeout per call, 10 s for the studio's hello.

## Studio

1. Instructions and tool descriptions move from `relay.mjs` into the studio (`script/AgentTexts.ts`), sent on connect. Both relays become plain message relays and the texts always match the studio version.
2. `AgentConnection` gets a mode (server, local). Server mode sends `hello` with the stored token and stores the one it receives (browser storage, per origin).
3. Connect Agent dialog: mode switch, the copy command (server mode), "New token", the token's expiry date.
4. Message protocol stays the same as the local relay (run, context, begin, end, called).

## Local relay

1. `relay.mjs` drops its own texts and uses the ones the studio sends.
2. Published as npm package `@opendaw/mcp-relay` with a bin, setup: `claude mcp add opendaw-local -- npx -y @opendaw/mcp-relay` (own name, so it never collides with the server entry `opendaw`). Both copied commands remove their entry first, so a new token or a second setup replaces it.

## Phases

1. ~~Move the agent texts into the studio, local relay uses them (no visible change).~~
2. ~~Server: token store, studio socket, MCP endpoint, rate limit. Tests with a fake studio and a fake agent in node, including: wrong token, expired token, token of another studio, second studio with the same token, disconnect mid call.~~
3. ~~Studio: server mode, dialog with copy command and new token.~~
4. ~~Infrastructure: `/agent/` forwarding in `yjs-server`, systemd service, deploy script. Deploy, then test with Claude Code against dev.opendaw.studio.~~
5. ~~Publish `@opendaw/mcp-relay`.~~
6. ~~Manual page "Connect an AI agent".~~
