# @opendaw/mcp-relay

Connects an AI agent like Claude Code to the [openDAW](https://opendaw.studio) studio open in your browser. Everything stays on your computer.

## Setup

1. In openDAW, open the openDAW menu, choose Connect Agent..., select Local Relay and copy the command.
2. Run it once in your terminal:

```
claude mcp add -s user opendaw-local -- npx -y @opendaw/mcp-relay
```

3. Click Connect in openDAW, then start a new Claude Code session and ask it to make music.

## How it works

The agent starts this relay. The studio connects to it on `ws://127.0.0.1:8790` and sends the tools, the rules and the scripting API. The agent's calls run as scripts in the open project, all changes of one request are a single undo step.

Set `OPENDAW_MCP_PORT` to use another port.

Without installing anything there is also the openDAW server mode, see Connect Agent in the studio.
