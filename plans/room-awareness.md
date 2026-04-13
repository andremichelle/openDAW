# Room Awareness: User Presence with Name, Color & Panel Location

## Goal

When users share a live room, each user has a **name**, a **color**, and a **panel location** (which panel their pointer is in). Other users see small coloured dots on panel headers indicating who is where.

---

## RoomAwareness Class

The core class owns a `DefaultObservableValue` for each field and exposes them as `MutableObservableValue` getters. When any field changes, a `deferNextFrame` callback batches the values and sends a single awareness update — allowing multiple fields to change in one frame without redundant broadcasts.

```typescript
class RoomAwareness implements Terminable {
    readonly #name: DefaultObservableValue<string>
    readonly #color: DefaultObservableValue<string>
    readonly #panel: DefaultObservableValue<Nullable<string>>

    get name(): MutableObservableValue<string>
    get color(): MutableObservableValue<string>
    get panel(): MutableObservableValue<Nullable<string>>
}
```

Internally subscribes to all three observables. Each subscription calls the same `deferNextFrame` function that reads current values from all three and calls `awareness.setLocalStateField("user", { name, color, panel })`.

### Panel Tracking via Surface.main

The `pointermove` listener is attached in `boot.ts` inside the `Surface.main({config})` callback. On each move, `(event.target as Element).closest("[data-panel-type]")` resolves the panel. The result is written to `roomAwareness.panel` — the `DefaultObservableValue` deduplicates (no update if same value), and the `deferNextFrame` batches the awareness broadcast.

### Identity Persistence

Name and color are persisted in `localStorage`:
- `opendaw:user:name` — string (default: `"Anonymous"`)
- `opendaw:user:color` — string (default: randomly assigned on first visit)

On construction, `RoomAwareness` reads from localStorage. When `name` or `color` observables change, the new values are written back to localStorage and batched into the next awareness update.

### Color Palette

A fixed set of 8-10 distinguishable colors (not from the existing `Colors` enum — those are UI theme colors). Something like:

```
#E06C75  #61AFEF  #98C379  #E5C07B  #C678DD  #56B6C2  #BE5046  #D19A66  #ABB2BF  #FF79C6
```

Each user picks or is randomly assigned one. Collisions are acceptable.

### Editing

Name and color are set in `StudioLiveRoomDialog.tsx` (the join-room dialog) before entering a room. The dialog pre-fills from localStorage so returning users get their previous values. Once in a room, clicking your own entry in the RoomStatus bar could reopen an editor, writing to the `MutableObservableValue` getters — persistence and awareness broadcast happen automatically.

---

## Awareness Protocol

Each client broadcasts its local state via the Yjs awareness protocol (`provider.awareness`). No server changes needed.

- `awareness.setLocalStateField("user", { name, color, panel })` to publish
- `awareness.getStates()` to read all clients
- `awareness.on("change", callback)` to react to additions/removals/updates

---

## RoomStatus Bar (`RoomStatus.tsx` + `.sass`)

A horizontal row inserted directly above the footer, only visible when in a room. Similar height and styling to the footer. Shows all connected users with their color dot and name — self first.

### Layout

```
[● You] [● Alice] [● Bob]                                    [connection status]
```

Each user entry is a colored dot + name. The local user appears first and could be clickable to open the identity editor. Future entries can show additional per-user status (uploading, downloading, stalled).

### Visibility

The row is conditionally shown/hidden based on room connection state. When not in a room, it is removed from the DOM entirely (no hidden class — avoids reserving space).

### Rendering

Driven by `awareness.on("change", ...)`. On each change, rebuild the user list from `awareness.getStates()`, sort self first, and update the DOM. Each entry is a small component with a dot `<span>` (background-color from user's color) and a name label.

### Extensibility

The row is designed to grow over time. Future additions per user:
- Upload/download progress indicators
- Connection quality / stalled state
- Panel location label next to the name

## Presence Dots on Panel Headers

In addition to the RoomStatus bar, small colored dots appear on panel headers (rendered by `PanelPlaceholder.tsx`) showing which users are in each panel. The local user is included and always shown first.

Each dot is ~6px with the user's color and name as tooltip. Driven by the same awareness change listener. For rooms with many users in one panel, show up to ~6 dots and a `+N` overflow.

### Pop-out Windows

When a panel is popped out into a separate window, it has its own `Surface`. The pop-out surface also needs a `pointermove` listener. The panel type is still available from the DOM.

---

## Integration Points

### `boot.ts` — Surface.main config

Attach the `pointermove` listener inside `Surface.main({config})`. On each event, resolve the panel via `closest("[data-panel-type]")` and write to `roomAwareness.panel`.

### `StudioLiveRoomConnect.ts` — Room join

After `YService.getOrCreateRoom()` succeeds:
1. Create `RoomAwareness` instance with the `provider.awareness`
2. Identity is loaded from localStorage automatically
3. Panel tracking is already active from boot
4. Register awareness change listener → update presence dots on all panel headers
5. Tear down on room disconnect (via terminator)

The footer label already shows room users count. It could be extended to show the user's own name/color and act as the trigger for the identity editor popover.

---

## New Files

| File | Purpose |
|------|---------|
| `RoomAwareness.ts` | Core class: DefaultObservableValues for name/color/panel, deferNextFrame batching, localStorage persistence |
| `RoomStatus.tsx` + `.sass` | Status bar above footer: user list with color dots, names, and future status indicators |
| `PresenceDots.tsx` + `.sass` | Component: renders colored dots on panel headers |
| `IdentityEditor.tsx` + `.sass` | Popover: name input + color swatches |

All in `packages/app/studio/src/ui/` or a new `packages/app/studio/src/room/` directory depending on preference.

---

## Implementation Phases

### Phase 1: RoomAwareness Class
- `DefaultObservableValue` for name, color, panel
- `deferNextFrame` batching for awareness updates
- localStorage read/write for name and color
- Random default color generation

### Phase 2: Panel Location Tracking
- `pointermove` listener in `Surface.main({config})` in `boot.ts`
- `closest("[data-panel-type]")` → write to `roomAwareness.panel`
- Handle pop-out surfaces

### Phase 3: RoomStatus Bar
- `RoomStatus.tsx`: horizontal row above footer, shown only when in a room
- Lists all users (self first) with color dot + name
- Driven by awareness change events

### Phase 4: Presence Dots on Panel Headers
- `PresenceDots` component for panel headers
- Awareness change listener builds panel→users map and updates dots
- Style: small colored circles with name tooltips

### Phase 5: Identity Editor
- Popover triggered by clicking own entry in RoomStatus bar
- Name text input + color swatch grid
- Writes to `MutableObservableValue` getters — everything else flows automatically

---

## Resolved Questions

1. Local user's dot appears in panel headers — always first, not excluded. Can be made a preference later.
