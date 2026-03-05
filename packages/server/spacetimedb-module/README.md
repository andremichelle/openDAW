# SpacetimeDB Server Module

Real-time collaboration backend for openDAW, powered by [SpacetimeDB](https://spacetimedb.com).

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [SpacetimeDB CLI](https://spacetimedb.com/install) v2.0+

The TypeScript client SDK (`spacetimedb` npm package) is already listed in `packages/studio/core/package.json`. Run `npm install` from the repo root if you haven't already.

## Local Development

### 1. Install the SpacetimeDB CLI

```bash
curl -sSf https://install.spacetimedb.com | sh
```

### 2. Start a local SpacetimeDB instance

```bash
spacetime start
```

This runs on `ws://localhost:3000` by default.

### 3. Publish the module

```bash
cd packages/server/spacetimedb-module
spacetime publish opendaw --server http://localhost:3000
```

### 4. Configure the client

Copy the env template and point to your local instance:

```bash
cp packages/app/studio/.env.example packages/app/studio/.env
```

Edit `.env`:

```dotenv
VITE_STDB_ENDPOINT=ws://localhost:3000
VITE_STDB_DATABASE=opendaw
```

Or set it at runtime in the browser via **Settings > Collaboration Server**.

### 5. Run the app

```bash
npm run dev:studio
```

## Cloud Deployment

To publish to SpacetimeDB Cloud:

```bash
spacetime publish opendaw --server https://maincloud.spacetimedb.com
```

The default `.env.example` already points to the cloud endpoint (`wss://maincloud.spacetimedb.com`).

## Module Structure

### Tables

| Table | Purpose |
|-------|---------|
| `room` | Active collaboration rooms |
| `room_participant` | Users currently in a room |
| `presence` | Cursor positions and display info |
| `box_state` | Synchronized box data (the DAW project graph) |
| `room_asset` | Registered audio assets per room |
| `webrtc_signal` | WebRTC signaling relay (offer/answer/ICE) |
| `cleanup_schedule` | Scheduled cleanup of stale rooms (every 5 min) |

### Reducers

| Reducer | Description |
|---------|-------------|
| `create_room` | Generate a new room with random 8-char ID |
| `join_room` | Join an existing room (validates display name) |
| `leave_room` | Leave a room |
| `promote_room` | Mark room as persistent (creator only) |
| `update_presence` | Update cursor position |
| `box_create` | Create a box in a room (validates JSON, 1MB limit) |
| `box_update` | Update box data (validates JSON, 1MB limit) |
| `box_delete` | Delete a box from a room |
| `register_asset` | Register an audio asset (100MB limit) |
| `send_signal` | Relay WebRTC signals between peers |

### Security

- All mutating reducers require room participation
- Display names: trimmed, non-empty, max 64 chars
- Box data: validated as JSON, max 1MB
- Signal payloads: max 16KB, type restricted to offer/answer/ice
- Assets: max 100MB, duplicate detection
- Stale rooms (no participants) cleaned up every 5 minutes

## Regenerating Client Bindings

After changing the module schema:

```bash
spacetime generate --lang typescript \
  --out-dir packages/studio/core/src/collab/stdb/module_bindings \
  --project-path packages/server/spacetimedb-module
```
