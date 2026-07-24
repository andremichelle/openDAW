# Room Creation Stats Page

## Goal

Track daily room sessions: how many rooms are created per day and how long each session lasts.
Display as a bar chart similar to the existing Users page (`/users`).

## Allowed Origins (for counting)

- `https://opendaw.studio` (production)
- `https://dev.opendaw.studio` (development)
- `https://localhost:8080` (local testing — remove before release)

---

## Architecture: Direct in the Yjs Server (Node.js)

The server already has ground truth — it knows exactly when rooms are created (`getYDoc`) and destroyed (cleanup in `closeConn`). No need for external HTTP calls or a separate PHP service.

- Track session start times in memory
- Compute duration when a room is cleaned up
- Write JSON files to disk on each finalization
- Serve the JSON files via the existing HTTPS handler

---

## Data Model

### In-memory: `roomSessions` map

```js
// Map<string, { origin: string, started: number }>
const roomSessions = new Map()
```

Populated when a new room is created, removed when the room is cleaned up.

### On disk: two JSON files

#### `data/rooms-count.json` — rooms created per day

```json
{ "2026-03-28": 5, "2026-03-29": 12 }
```

Simple date → count, same format as `users/graph.json`.

#### `data/rooms-duration.json` — total session duration per day

```json
{ "2026-03-28": 342, "2026-03-29": 890 }
```

Date → total minutes (sum of all room durations that day).

---

## Implementation Plan

### 1. Yjs Server Changes (`utils.js`)

#### On room creation (in `getYDoc` or `setupWSConnection`)

When a new room is created (not retrieved from cache), record the session:

```js
const isNewRoom = !docs.has(docName)
const doc = getYDoc(docName, gc)

if (isNewRoom) {
    roomSessions.set(docName, { origin, started: Date.now() })
}
```

Only record if the origin is in the allowed list.

#### On room cleanup (in `closeConn`, where `docs.delete(doc.name)` happens)

Compute duration and write to disk:

```js
const session = roomSessions.get(doc.name)
if (session) {
    const durationMinutes = Math.max(1, Math.round((Date.now() - session.started) / 60_000))
    const day = new Date(session.started).toISOString().slice(0, 10)
    appendToStats(day, durationMinutes)
    roomSessions.delete(doc.name)
}
```

#### `appendToStats` helper

```js
const dataDir = path.join(__dirname, 'data')

function appendToStats(day, durationMinutes) {
    const countFile = path.join(dataDir, 'rooms-count.json')
    const durationFile = path.join(dataDir, 'rooms-duration.json')

    const counts = JSON.parse(fs.readFileSync(countFile, 'utf8'))
    counts[day] = (counts[day] || 0) + 1
    fs.writeFileSync(countFile, JSON.stringify(counts))

    const durations = JSON.parse(fs.readFileSync(durationFile, 'utf8'))
    durations[day] = (durations[day] || 0) + durationMinutes
    fs.writeFileSync(durationFile, JSON.stringify(durations))
}
```

### 2. Serve JSON via HTTPS handler (`server.js`)

The server already has an HTTPS handler that returns `"okay"`. Add routes to serve the stats JSON with CORS:

```js
const server = https.createServer(certConfig, (req, res) => {
    const allowedOrigins = [
        'https://opendaw.studio',
        'https://dev.opendaw.studio',
        'https://localhost:8080'
    ]
    const origin = req.headers.origin
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
    }

    if (req.url === '/stats/rooms-count.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(fs.readFileSync(path.join(dataDir, 'rooms-count.json'), 'utf8'))
        return
    }
    if (req.url === '/stats/rooms-duration.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(fs.readFileSync(path.join(dataDir, 'rooms-duration.json'), 'utf8'))
        return
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('okay')
})
```

### 3. Frontend: Two pages, each a bar chart

#### `RoomsCountPage.tsx` — rooms created per day

- Fetch from `https://live.opendaw.studio/stats/rooms-count.json`
- Same bar chart as `UsersPage.tsx` (date → number)
- Title: "Rooms Created Per Day"

#### `RoomsDurationPage.tsx` — total session duration per day

- Fetch from `https://live.opendaw.studio/stats/rooms-duration.json`
- Same bar chart as `UsersPage.tsx` (date → number), Y-axis labeled in minutes
- Title: "Total Room Duration Per Day"

### 4. Route Registration (`App.tsx`)

Move the existing users page and add the two new room pages:

```tsx
{path: "/stats/users", factory: UsersPage}
{path: "/stats/rooms-created", factory: RoomsCountPage}
{path: "/stats/rooms-duration", factory: RoomsDurationPage}
```

Remove the old `/users` route.

---

## File Changes Summary

| File | Change |
|------|--------|
| `packages/server/yjs-server/utils.js` | Track room sessions in memory, write stats on cleanup |
| `packages/server/yjs-server/server.js` | Serve stats JSON via HTTPS handler with CORS |
| **NEW** `packages/server/yjs-server/data/rooms-count.json` | `{}` — daily room count |
| **NEW** `packages/server/yjs-server/data/rooms-duration.json` | `{}` — daily total duration in minutes |
| **NEW** `packages/app/studio/src/ui/pages/RoomsCountPage.tsx` | Bar chart: rooms per day |
| **NEW** `packages/app/studio/src/ui/pages/RoomsDurationPage.tsx` | Bar chart: total minutes per day |
| **NEW** `packages/app/studio/src/ui/pages/RoomsPage.sass` | Shared styling (reuse UsersPage pattern) |
| `packages/app/studio/src/ui/App.tsx` | Move `/users` → `/stats/users`, add `/stats/rooms-created` and `/stats/rooms-duration` |

## Before Release Checklist

- [ ] Remove `https://localhost:8080` from allowed origins in server.js
- [ ] Ensure `data/` directory exists on the production server
- [ ] Include `data/` directory in deploy script (`deploy-yjs.sh`)
