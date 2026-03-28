# Room Creation Stats Page

## Goal

Track daily room sessions: how many rooms are created per day and how long each session lasts.
Display as a bar chart similar to the existing Users page (`/users`).

## Allowed Origins (for counting)

- `https://opendaw.studio` (production)
- `https://dev.opendaw.studio` (development)
- `https://localhost:8080` (local testing — remove before release)

---

## Architecture: PHP on `api.opendaw.studio`

Consistent with the existing `users/` pattern. PHP has filesystem access to read/write JSON files, is decoupled from the Yjs server, and survives server restarts.

---

## Data Model

### `sessions.json` — live session tracking

Tracks active and completed sessions. The Yjs server pings this to keep sessions alive.

```json
{
  "abc123": { "origin": "https://opendaw.studio", "started": "2026-03-28T14:30:00Z", "lastPing": "2026-03-28T15:10:00Z" },
  "def456": { "origin": "https://localhost:8080", "started": "2026-03-28T16:00:00Z", "lastPing": "2026-03-28T16:05:00Z" }
}
```

- Key: room name (docName from Yjs)
- `started`: timestamp when the room was first created
- `lastPing`: timestamp of the most recent heartbeat
- Sessions with no ping for >2 minutes are considered ended

### Two graph files — aggregated daily stats (served to frontend)

#### `rooms-count.json` — rooms created per day

```json
{ "2026-03-28": 5, "2026-03-29": 12 }
```

Simple date → count, same format as `users/graph.json`.

#### `rooms-duration.json` — total session duration per day

```json
{ "2026-03-28": 342, "2026-03-29": 890 }
```

Date → total minutes (sum of all room durations that day). This is additive — a day with 3 rooms of 60 min each = 180 min.

---

## Implementation Plan

### 1. PHP Backend (`api.opendaw.studio/rooms/`)

#### `room-ping.php` — single endpoint for create + heartbeat

Accepts POST with JSON body:
```json
{ "room": "abc123", "origin": "https://opendaw.studio" }
```

Logic:
1. Validate origin is in the allowed list
2. Read `sessions.json`
3. If room does **not** exist → new session: store `{ origin, started: now, lastPing: now }`
4. If room **already** exists → heartbeat: update `lastPing` to now
5. **Finalize stale sessions:** Scan all sessions. Any session with `lastPing` older than 2 minutes is considered ended:
   - Compute duration = `lastPing - started`
   - In `rooms-count.json`: increment the day's count by 1 (using the `started` date)
   - In `rooms-duration.json`: add duration in minutes to the day's total (using the `started` date)
   - Remove from `sessions.json`
6. Write back `sessions.json`
7. Return `{ "ok": true }`

Using a single endpoint keeps things simple — the Yjs server just pings periodically and the PHP side handles the state machine (create vs. heartbeat vs. finalize).

#### `rooms-count.json` + `rooms-duration.json` — aggregated data (read by frontend)

- Served with CORS headers for the allowed domains
- Same static-file pattern as `users/graph.json`

#### CORS

- `.htaccess` or PHP headers to allow the frontend domains

### 2. Yjs Server Changes (`utils.js`)

#### On room creation

In `setupWSConnection`, before calling `getYDoc()`:

```js
const isNewRoom = !docs.has(docName)
const doc = getYDoc(docName, gc)

if (isNewRoom) {
    // Start pinging for this room
    const pingInterval = setInterval(() => {
        if (!docs.has(docName)) {
            clearInterval(pingInterval)
            return
        }
        fetch("https://api.opendaw.studio/rooms/room-ping.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ room: docName, origin })
        }).catch(err => console.warn("Room ping failed:", err))
    }, 60_000) // every 60 seconds

    // Send initial ping immediately
    fetch("https://api.opendaw.studio/rooms/room-ping.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: docName, origin })
    }).catch(err => console.warn("Room creation report failed:", err))
}
```

The interval pings every 60s. When the room is cleaned up (removed from `docs` map in `closeConn`), the next interval tick sees the room is gone and clears itself. The PHP side will finalize the session after 2 minutes of no pings.

#### Tracking ping intervals

Store the interval ID so it can be cleaned up:

```js
// Map<string, NodeJS.Timeout> — track ping intervals per room
const roomPingIntervals = new Map()
```

Clear in room cleanup (inside `closeConn` where `docs.delete(doc.name)` happens):

```js
const pingInterval = roomPingIntervals.get(doc.name)
if (pingInterval) {
    clearInterval(pingInterval)
    roomPingIntervals.delete(doc.name)
}
```

### 3. Frontend: Two pages, each a bar chart

#### `RoomsCountPage.tsx` — rooms created per day

- Fetch from `https://api.opendaw.studio/rooms/rooms-count.json`
- Same bar chart as `UsersPage.tsx` (date → number)
- Title: "Rooms Created Per Day"

#### `RoomsDurationPage.tsx` — total session duration per day

- Fetch from `https://api.opendaw.studio/rooms/rooms-duration.json`
- Same bar chart as `UsersPage.tsx` (date → number), Y-axis labeled in minutes
- Title: "Total Room Duration Per Day"

### 4. Route Registration (`App.tsx`)

```tsx
{path: "/rooms", factory: RoomsCountPage}
{path: "/rooms/duration", factory: RoomsDurationPage}
```

---

## File Changes Summary

| File | Change |
|------|--------|
| **NEW** `api.opendaw.studio/rooms/room-ping.php` | Single endpoint: create, heartbeat, finalize |
| **NEW** `api.opendaw.studio/rooms/sessions.json` | `{}` — live session state |
| **NEW** `api.opendaw.studio/rooms/rooms-count.json` | `{}` — daily room count |
| **NEW** `api.opendaw.studio/rooms/rooms-duration.json` | `{}` — daily total duration in minutes |
| `packages/server/yjs-server/utils.js` | Ping PHP on room create + 60s interval, cleanup on room destroy |
| **NEW** `packages/app/studio/src/ui/pages/RoomsCountPage.tsx` | Bar chart: rooms per day |
| **NEW** `packages/app/studio/src/ui/pages/RoomsDurationPage.tsx` | Bar chart: total minutes per day |
| **NEW** `packages/app/studio/src/ui/pages/RoomsPage.sass` | Shared styling (reuse UsersPage pattern) |
| `packages/app/studio/src/ui/App.tsx` | Add `/rooms` and `/rooms/duration` routes |

## Before Release Checklist

- [ ] Remove `https://localhost:8080` from allowed origins in `room-ping.php`
- [ ] Verify CORS headers on `rooms-count.json` and `rooms-duration.json`
