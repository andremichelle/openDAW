# Live Room Chat Panel

## Goal

Add a floating chat overlay that slides in from the right edge of the screen when the user is in a live room. A half-circle tab with a chat icon peeks from the right edge; clicking it slides the chat window into view. Clicking the tab again (still attached) slides it back out. The entire element is hidden when not in a room.

## Architecture Decision: Global Overlay vs Panel System

The existing panel system (`WorkspaceBuilder`, `PanelPlaceholder`, `PanelState`) is **per-screen** — each screen defines its own panel layout. Adding a chat panel to every screen would be invasive and fragile.

Instead, the chat overlay lives at the **App level** (`App.tsx`), alongside `RoomStatus` and `Footer`. This mirrors how `RoomStatus` already conditionally renders based on `roomAwareness`. As a `position: fixed` overlay, it floats above all content on all routes and screens without affecting layout.

## Visual Design

### Closed State
- A half-circle (clipped circle) hugs the right edge of the viewport, vertically centered
- Shows `IconSymbol.ChatEmpty` icon
- When unread messages exist: switches to `IconSymbol.ChatMessage` with brighter/highlighted styling
- Clicking it slides the chat window in from the right

### Open State
- The chat window slides in from the right edge with a CSS transition
- Positioned `top: 10%`, `bottom: 10%`, fixed width (~320px)
- The half-circle tab remains attached to the left edge of the chat window (acts as close button)
- Window contains:
  - Message list (scrollable, auto-scroll to bottom on new messages)
  - Options row with two checkboxes
  - Text input + send button at the bottom
- Each message: colored dot + sender name + text
- Own messages visually distinguished (e.g. subtle background tint)

### Transitions
- `transform: translateX(100%)` (closed) to `translateX(0)` (open)
- The tab is always visible (it sticks out from the right edge even when the window is off-screen)
- Rapid clicks during animation are fine — CSS transitions handle mid-flight reversal naturally

```
Closed:                          Open:

┌─────────────────────┐ ╮        ┌──────────────────╮──────────────┐
│                     │ │        │                  │  Room Chat   │
│                     │ │        │                  ├──────────────┤
│                     │💬        │                  │ bob: hello   │
│     workspace       │ │        │    workspace     │💬 ann: hi!   │
│                     │ │        │                  │ bob: ready?  │
│                     │ │        │                  ├──────────────┤
│                     │ ╯        │                  │ ☑ send enter │
│                     │          │                  │ ☑ close after│
└─────────────────────┘          └──────────────────╯─[_____|send]─┘
```

## Message Transport: Y.Array on the Shared Y.Doc

The Yjs Y.Doc already syncs between all peers in a room. Adding a `Y.Array<ChatMessage>` to the doc gives us:

- Automatic sync to all connected peers (no extra server work)
- Messages persist as long as the room exists (transient, like the room itself)
- CRDT ordering handles concurrent sends
- No server changes required

The Y.Doc is created in `YService.getOrCreateRoom()` and is accessible via `provider.doc` — no need to change `YService.RoomResult`.

### Message Shape

```typescript
type ChatMessage = {
    id: string        // UUID for dedup
    name: string      // sender display name
    color: string     // sender color
    text: string      // message content
    timestamp: number // Date.now()
}
```

## Implementation Steps

### 1. Create a ChatService

**New file:** `packages/app/studio/src/service/ChatService.ts`

Responsibilities:
- Holds a reference to `doc.getArray("chat")` (Y.Array)
- `sendMessage(text: string)` — rejects empty/whitespace-only strings, trims to 300 chars, pushes a `ChatMessage` to the Y.Array
- Exposes the Y.Array for the UI to observe via `yArray.observe(callback)`
- Implements `Terminable` for cleanup (unobserves Y.Array)

Constructor receives: `Y.Doc` (accessed via `provider.doc`), user `name`, user `color`.

### 2. Wire ChatService into Room Lifecycle

**File:** `StudioLiveRoomConnect.ts`

After creating `RoomAwareness` (line 47), create a `ChatService`. Access the Y.Doc via `provider.doc` — no changes to `YService` needed:

```typescript
const chatService = new ChatService(provider.doc, userName, userColor)
terminator.own(chatService)
service.setChatService(chatService)
terminator.own({ terminate: () => service.setChatService(null) })
```

### 3. Add ChatService Observable to StudioService

**File:** `StudioService.ts`

Add a `chatService` observable, mirroring the `roomAwareness` pattern:

```typescript
readonly #chatService = new DefaultObservableValue<Nullable<ChatService>>(null)
get chatService(): ObservableValue<Nullable<ChatService>> { return this.#chatService }
setChatService(value: Nullable<ChatService>): void { this.#chatService.setValue(value) }
```

### 4. Build the ChatOverlay Component

**New file:** `packages/app/studio/src/ui/ChatOverlay.tsx`
**New file:** `packages/app/studio/src/ui/ChatOverlay.sass`

Structure:
```
div.chat-overlay (position: fixed, right: 0, top: 10%, bottom: 10%)
├── div.chat-tab (half-circle, always visible, onclick toggles open/closed)
│   └── Icon (ChatEmpty when no unread, ChatMessage when unread — brighter styling)
└── div.chat-window (fixed width ~320px, slides with transform)
    ├── header ("Room Chat")
    ├── div.messages (flex: 1, overflow-y: auto)
    │   └── div.message * N (dot + name + text)
    ├── div.options
    │   ├── label: checkbox "Send on Enter" (default: checked)
    │   └── label: checkbox "Close after send" (default: checked)
    └── div.input-area
        ├── input (text, maxLength 300)
        └── button (send icon — always present)
```

Behavior:
- Subscribes to `service.chatService` — entire overlay hidden (`display: none`) when null
- `open` boolean state toggles a CSS class that controls `translateX`
- The tab is positioned to the left of the window so it always peeks out from the right edge
- Observes Y.Array via `yArray.observe(callback)` for incoming messages
- Auto-scrolls message list on new messages (only if already scrolled to bottom)
- Tracks unread count: incremented when closed and messages arrive, cleared when opened

Keyboard shortcuts:
- No extra work needed. The `ShortcutManager` already skips shortcuts when focus is in an `<input>` element via `Events.isTextInput()` check. Chat input works without conflicts.

Focus and send flow:
- **On open:** the input field receives focus immediately after the slide-in transition ends (`transitionend` event)
- **Send on Enter** checkbox (default: checked, persisted in localStorage `opendaw:chat:sendOnEnter`): when enabled, pressing Enter in the input sends the message. When unchecked, Enter inserts nothing — user clicks the send button instead.
- **Close after send** checkbox (default: checked, persisted in localStorage `opendaw:chat:closeAfterSend`): when enabled, sending a message triggers the slide-out close animation immediately after send.
- The input is cleared after every send regardless of checkbox state.
- Empty/whitespace-only messages are rejected (send button disabled, Enter does nothing).
- The send button is always present in the input area for when "Send on Enter" is unchecked.

### 5. Integrate ChatOverlay into App

**File:** `App.tsx`

Add `ChatOverlay` as a sibling — no wrapper needed since it's `position: fixed`:

```tsx
<Frag>
    <Header ... />
    <Router ... />
    <ChatOverlay lifecycle={terminator} service={service} />
    <RoomStatus ... />
    <Footer ... />
</Frag>
```

No layout changes to existing elements. The overlay floats independently.

### 6. Styling Details

```sass
.chat-overlay
    position: fixed
    right: 0
    top: 10%
    bottom: 10%
    z-index: 5000    // above tooltips (1000), below dialogs/menus (9999)
    display: flex
    transition: transform 0.25s ease-in-out
    transform: translateX(100%)
    pointer-events: none

    &.open
        transform: translateX(0)

    .chat-tab
        pointer-events: auto
        width: 40px
        height: 40px
        border-radius: 20px 0 0 20px
        position: absolute
        left: -40px
        top: 50%
        transform: translateY(-50%)
        cursor: pointer

        &.unread
            // brighter background, ChatMessage icon

    .chat-window
        pointer-events: auto
        width: 320px
        display: flex
        flex-direction: column
        border-radius: 8px 0 0 8px
```

## Files Changed

| File | Change |
|------|--------|
| `StudioService.ts` | Add `chatService` observable |
| `StudioLiveRoomConnect.ts` | Create and wire `ChatService` |
| `App.tsx` | Add `ChatOverlay` component |
| **New:** `ChatService.ts` | Y.Array-backed chat service |
| **New:** `ChatOverlay.tsx` | Floating chat overlay component |
| **New:** `ChatOverlay.sass` | Overlay and transition styles |

## No Server Changes

The existing Yjs WebSocket server syncs the entire Y.Doc transparently. Adding a new Y.Array to the doc requires zero server modifications. Messages flow through the same sync channel as box graph updates.

## Resolved Decisions

- **Icons:** `IconSymbol.ChatEmpty` (tab idle), `IconSymbol.ChatMessage` (tab with unread — brighter styling). Already added to the enum.
- **Message length cap:** 300 characters per message enforced via `maxLength` on input and truncation before send.
- **Unread indicator:** No sound. Tab icon switches from `ChatEmpty` to `ChatMessage` with highlighted styling. Resets when opened.
- **Name/color immutability:** Messages store name and color as immutable snapshots at send time. No retroactive updates.
- **Empty messages:** Rejected. Send button disabled and Enter ignored when input is empty/whitespace-only.
- **Send button:** Always present in input area, required for when "Send on Enter" is unchecked.
- **Rapid clicks:** CSS transitions handle mid-flight reversal naturally. No debouncing needed.
- **Z-index:** 5000 — above tooltips (1000) but below dialogs/context menus (9999).
- **Keyboard shortcuts:** No conflicts. `ShortcutManager` already gates on `Events.isTextInput()` and skips shortcuts when an `<input>` is focused.
- **Y.Doc access:** Via `provider.doc` in `StudioLiveRoomConnect.ts`. No changes to `YService.ts` needed.
