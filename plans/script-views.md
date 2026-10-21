# Script Views: custom UI + custom data for Werkstatt / Apparat / Spielwerk

Status: DRAFT 2026-10-21, nothing implemented.

Goal: a scriptable device can ship its own editor element (pattern grid, harmonic bars, spectrum, preview keys)
and its own persistent data beyond `@param`, without the script touching the studio, and without UI and
processor sharing state.

## 1. One script, three entry points

The device stays ONE script in the existing `code` field: paste, compile, run. It has three entry points:

| Entry point | Realm | Holds |
|---|---|---|
| directive header | nowhere, parsed only | `@param`, `@sample`, `@sidechain`, `@group`, `@collection`, `@field`, `@stream`, `@view` |
| `class Processor` | audio thread (TS worklet or WASM script bridge) | DSP / note generation |
| `class View` | sandboxed iframe on the main thread | the custom element |

The whole script is evaluated in BOTH realms. The worklet instantiates only `Processor`, the iframe only `View`.
Evaluating the other class is harmless (declaring a class runs none of its methods). A script without
`class View` behaves bit-identically to today. No schema change for the code itself.

Later, the code editor gets jump-to-entry-point (Data, Processor, View) from the directive header and the two
class declarations.

### 1.1 No shared state (issue 2)

The danger of one script in two realms: a top-level `let current = 0` exists twice, the view writes its copy,
the processor never sees it. That must be impossible, not a convention. Two layers:

1. Static top-level rule, checked by the compiler before anything is registered. At depth 0 the script may only
   contain:
   - `// @...` directives and comments
   - `class Name {...}`
   - `function name(...) {...}` (also `function*`, `async function`)
   - `const NAME = <expression>` (simple identifiers, no destructuring)

   Rejected with line number and a fix hint: top-level `let` / `var`, expression statements (`init()`,
   `SCALES.push(...)`), destructuring `const`, `export` / `import`, private static fields (`static #count = 0`,
   freeze cannot reach them, private static METHODS stay allowed). Example message:
   `Line 4: top-level 'let current' would exist separately in the processor and the view. Move it into the class.`
2. Runtime freeze, in both realms. The compiler appends, after the user code inside the wrapper, a deep
   `Object.freeze` over every top-level `const` value, every top-level function and every class constructor
   (statics). Class prototypes are NOT frozen: a frozen prototype breaks `this.draw = this.draw.bind(this)` in a
   constructor (the JS "override mistake"), a very common View pattern. So:
   - `SCALES.push(7)` throws, `Helper.cache = x` and `static counter` writes throw (the wrapper is strict mode).
   - `Map`, `Set`, `WeakMap`, `Date`, `ArrayBuffer` values are rejected at compile: `Object.freeze` does not freeze
     their contents, `const CACHE = new Map()` would silently stay shared mutable state (verified in the prototype).
   - A top-level `const TABLE = new Float32Array(2048)` fails at compile with
     `typed arrays are mutable, create 'TABLE' in the constructor` (freeze cannot freeze a non-empty typed array,
     which is exactly the right verdict).
   - Duplicated immutable constants and pure helpers in both realms are fine, they cannot diverge.
   - Closures created at top level are rejected: a `const` whose value contains a function (directly or inside an
     object / array) must spell every function as a literal (`function`, arrow, `class`, method). If its
     initializer CALLS something (`makeCounter()`, an IIFE), the compile fails with
     `'next' is a function created by a call, it can hold hidden state. Declare it as a function or move it into the class.`
     The check is the scanner's verdict (initializer contains a call) combined with the runtime walk over the frozen
     value (contains a function). Non-intrusive: `const TABLE = Array.from({length: 16}, (entry, index) => index * 2)`
     and `const ROOT = Math.pow(2, 1 / 12)` still pass, because their values hold no function.
   - What stays possible is only deliberate and not accidental: mutating a prototype from inside a method
     (`Object.getPrototypeOf(this).shared = 1`). Documented, not policed.
3. Implicit and explicit globals: the wrapper is `"use strict"`, so assignments to undeclared names throw. The
   wrapper shadows `globalThis`, `self`, `window`, `openDAW` and `sampleRate`-adjacent registries as parameters
   set to `undefined` (`sampleRate` and the documented globals stay). This is a correctness guard against
   `globalThis.shared = ...` expecting the other realm to see it, not a security boundary (the processor side is
   the user's own code in the user's own worklet, as today, and the view side is sandboxed anyway).
4. Instance state is per realm by nature: `this.held` in `Processor` and `this.current` in `View` are separate
   objects in separate threads. Data the processor receives (`this.data.steps`) is frozen, so the processor
   cannot write it back by accident either.

The top-level scanner is homebrew (minimal dependencies): a tokenizer that skips comments, strings, template
literals with nested `${}`, and regex literals (previous-token heuristic), tracks brace / paren / bracket depth,
and classifies each depth-0 line start. A depth-0 line start that is not a declaration keyword and not an
expression continuation (`.`, `?`, `:`, an operator, a closing bracket) is rejected. Ambiguous input fails loudly
with a line number, never silently passes, and the runtime freeze backs up whatever the scanner cannot see.
Fallback if edge cases pile up: acorn (zero dependencies, exact AST), only on approval.

Tested case by case: every example script, every pattern above, plus edge cases (regex containing `{`, template
literals containing backticks in `${}`, comments containing `let`, ASI continuations).

Affected: `ScriptCompiler.wrap` (two wrappers from one source, processor + view), `ScriptDeclaration` (new
directives), Monaco declarations for `View` and `host`, the AI starter prompt, the scripting docs, examples.

## 2. Isolation of the view (issue 1)

Decision: one sandboxed `<iframe>` per view instance (inline or window).

- `sandbox="allow-scripts"` WITHOUT `allow-same-origin`: opaque origin, no access to `parent`, studio DOM,
  cookies, `localStorage`, IndexedDB, OPFS, service worker. No `allow-popups`, `allow-modals`, `allow-forms`,
  `allow-top-navigation`.
- `srcdoc` built by the host: CSP meta `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob:; font-src <studio origin>` so `fetch`, websockets and remote images are blocked (no
  exfiltration of project data). Fonts load from the studio origin only, so a view uses the studio UI font.
- Cannot flow into the studio UI: the iframe IS the clip rect. The host sizes it to its grid slot, the script draws
  inside, overflow is physically impossible.
- One channel: the host transfers a `MessagePort` at boot. Every inbound message is validated against the manifest
  (known collection / field / param names, numeric values, clamped to declared min/max, size caps, rate limit per
  frame). The host never evaluates anything it receives. Names checked with Maps, `__proto__` rejected as today.
- The view can only reach its own device: the host resolves names to THIS device's boxes, there is no address,
  uuid or box in the API.
- Recompile = new `srcdoc` = fresh realm. Nothing is lost because all persistent state lives in boxes.
- The view realm is disposable, one realm per view instance, never re-instantiated in place. Recompile, close or
  device removal throws the iframe away, and every `ResizeObserver`, event listener, timer and animation frame
  of the script dies with it. The script owes no cleanup.
- The host owns everything on its side: on iframe teardown it terminates every subscription the view created
  (`host.data` / `host.streams` / `host.params`), approves an open `gesture`, releases held preview notes and
  closes the port. It never relies on the script, so a throwing or careless view cannot leak.
- Studio shortcuts: the runtime forwards `keydown` events the view did not `preventDefault()` to the host
  (space = play keeps working while the view has focus).
- Theme: the host injects the current colour scheme as CSS variables into the iframe, `host.color("blue")` reads them.

Rejected: Shadow DOM (no JS isolation), ShadowRealm (not shipped, no DOM), Worker + OffscreenCanvas (isolation
fine but canvas only, every pointer event hand-forwarded, no DOM controls).

Cost: one realm per visible view. Bound to the device editor lifecycle, created only when the device panel shows it.

## 3. Sharing more than parameters (issue 3)

Three channels, each with a clear contract:

| Channel | Direction | Persistent | Undoable | Renders offline | Use for |
|---|---|---|---|---|---|
| `@param` | view ⇄ processor | yes | yes | yes | automatable values (unchanged) |
| `@collection` | view writes, processor reads | yes | yes | yes | patterns, partials, step data |
| `@stream` | processor → view | no | no | n/a | spectrum, scope, current step |
| `send` / `message` | view → processor | no | no | NO | transient pokes (reset a meter) |

Anything that must affect the rendered result is a param or a collection, never a message.

### 3.1 Collections (the custom data)

```
// @collection steps 16
// @field steps.on        true
// @field steps.velocity  0.8   0    1   linear
// @field steps.transpose 0    -12  12   int  st
```

- `@field` reuses the `@param` token grammar exactly (default min max mapping unit), one parser. Values are
  stored as `float32` (ints exact up to 2^24).
- Two ways to declare the records, mutually exclusive per collection:
  - `// @collection steps 16`: 16 records, every field at its `@field` default.
  - `// @collection partials` followed by one `// @record partials level=1` line per record: every record seeded
    explicitly, fields not named in a line take their `@field` default. Order of the lines = record order.
- The declaration is the TARGET shape, not a limit. The view can still insert / remove records at runtime.
- Recompile with a changed declaration (16 to 32, or 16 to 8, or edited `@record` lines): grow appends new
  records (defaults or seeds), shrink removes trailing records, every surviving record keeps its current values
  (the data is carried over, nothing is re-created). Side effects, and how they are contained:
  - Only a CHANGED declaration reshapes. The compiler parses the declaration from the previous code in the box
    and compares. Recompiling with the same declaration leaves a pattern whose length the user changed in the
    view (16 to 12 steps) alone, otherwise every compile would snap it back.
  - An edited `@record` seed is written only into records that still hold the OLD seed value, user edits win.
  - Shrinking deletes the trailing records' user data. It is the same transaction as the code change, so one
    undo restores both.
- Values are numbers (int, float, bool), mapped and clamped like params. No strings in v1.
- Boxes, hub + child boxes as everywhere else. Each carries the label (reconcile by name, robust against
  reordering) AND the declaration index (the wire id, so Rust never decodes strings), like `WerkstattParameterBox`:
  - `ScriptRecordBox { owner -> device.records, collection: string, collection-index: int32, order: int32 }`
  - `ScriptValueBox  { owner -> record.values, field: string, field-index: int32, value: float32 }`
  - `order` is the record position. Inserting in the middle rewrites `order` of every following record (N field
    writes in one transaction). Acceptable for patterns, revisit if collections grow large.
  - Fine-grained: one value edit = one field change, merges in Live rooms, undo per gesture.
- Reconcile on compile like `reconcileParameters`: new field = value boxes with defaults in every record, removed
  field = value boxes deleted, changed min/max = values clamped, removed collection = records deleted.
- Processor side: `this.data.steps` is an array of frozen plain objects `{on, velocity, transpose}`, rebuilt after
  the transaction (update clock, never mid-block). `dataChanged(name)` is called after a rebuild and once after
  construction. The processor never writes data (the audio thread must not create transactions, and composite
  replicas would write N times).
- Engine: scripts only run in the WASM engine (the TS script processors are gone, `core-processors` has none). The
  three crates export `observe_record_collection_field() -> <hub key>`, and `crates/engine/src/script_device.rs`
  gets `observe_script_records` next to `observe_script_params` / `observe_script_samples`, reusing
  `collection_children` twice (records of the device, values of each record). On any change it delivers deltas:
  `host_script_value(handle, collection, order, field, value)` for a value edit, and a full
  `host_script_data(handle, collection, ptr, records, fields)` snapshot for structural changes (insert / remove /
  reorder). `// WASM CONTRACT:` markers on both sides.
- The bridge caches the collections like `rawParams` (data arrives before the Processor exists, and must survive a
  hot-swap), replays them after construction, then calls `dataChanged` for every collection. A value delta
  replaces only that record object (copy on write) and the outer array, so references the processor holds to
  an old array stay consistent.

Later (phase 6), bulk data: `// @buffer wave 2048` = `ScriptBufferBox { owner, label, data: bytes }`, replaced
whole per edit, for drawable wavetables or curves where one box per value would be absurd.

### 3.2 Streams (processor to view)

```
// @stream step 1          value: fixed Float32Array the processor overwrites
// @stream scope 1024 ring ring: the processor appends blocks, the view receives the latest 1024 in order
// @stream spectrum 512 fft  fft: the processor appends blocks like ring, the view receives 512 magnitudes
```

- Processor: `this.streams.step[0] = index`, `this.streams.scope.write(channel, s0, s1)` (`fft` streams too).
- `fft` is a ring of `2 × bins` samples on the wire. The view runtime inside the iframe applies a Hann window and
  the lib-dsp FFT (bundled into the runtime, not exposed) and hands the subscriber `bins` linear magnitudes.
  Nothing is computed on the audio thread, and the host API stays I/O only (no math utilities on `host`).
- Not through the Rust broadcast ABI: `abi::bind_broadcast` binds in the crate's `init`, before the script is
  loaded, while streams change with every compile. Instead the script bridge registers them directly on the
  worklet's JS `LiveStreamBroadcaster` (`core-wasm/src/processor.ts`, same scope as the bridge, passed into
  `ScriptBridges`), at the device address + `[0x1000 + stream index]`, re-registered on hot-swap. No ABI change.
- No latency alignment: packets are shown as they arrive. A step highlight may lead the audio by the output
  latency, accepted.
- `this.streams.scope.active` mirrors the subscription state, so a processor skips stream work while no view is open.
  The view receives at most one packet per animation frame.
- Composite replicas share the device address: only the first instance (lowest handle) broadcasts.
- Offline render: streams are not shipped.

### 3.3 Preview

`host.preview.noteOn(pitch, velocity)` / `noteOff(pitch)` routes through the existing engine `NoteSignal` of the
device's audio unit (Apparat, and Spielwerk through its downstream instrument). No processor code needed.

## 4. Layout (issue 4)

The three-row grid stays and fills top to bottom, column by column, as today. A view claims a rectangle of
cells, and every other control fills the remaining free cells in the usual order, skipping the occupied ones.

```
// @param rate 120 30 480 int
// @param mode 0 0 2 int
// @param swing 0
// @param octaves 1 1 4 int
// @view PatternView 2 1 8 2    class PatternView at column 2, row 1, 8 × 2 cells
// @view ScopeView 2 3 4 1      class ScopeView below it, 4 × 1 cells
```

```
        col 1    col 2 .. 5        col 6 .. 9
row 1   rate     PatternView ................
row 2   mode     PatternView ................
row 3   swing    ScopeView         octaves, then the free cells
```

`rate`, `mode`, `swing` fill column 1. `PatternView` takes columns 2 to 9 of rows 1 and 2, `ScopeView` columns
2 to 5 of row 3. Auto-flow continues in column order and skips occupied cells, so `octaves` lands in row 3 of
column 6 and the next controls take row 3 of columns 7 to 9 before a new column starts.

- `// @view [Class] <column> <row> <columns> <rows>`, 1-based like the cells you count on screen, default class
  `View`. `row + rows - 1` must not exceed 3, `column` is open-ended (the section grows to the right).
- Native CSS grid: a view gets `grid-column: <column> / span <columns>` and `grid-row: <row> / span <rows>`.
  Explicitly placed items are placed first, the auto-flow controls (`grid-auto-flow: column`) then take the free
  cells in their declaration order. No custom layout code, the browser does the skipping.
- Size of a view: `columns × 3.5em + (columns - 1) × 0.25em` by `rows × 3.5em + (rows - 1) × 0.25em`. It
  follows the UI zoom because it is in em, the view reacts with a native `ResizeObserver`.
- Coordinates are relative to the section the `@view` line belongs to: the ungrouped run or the `@group` it is in,
  since each section is its own grid today. Column 1 is the first column of that section.
- Overlap: two views claiming a shared cell are both shown, with a red rectangle over the shared cells, and the
  `@view` lines get a warning marker in the code editor naming the other view. Same for a view leaving the 3 rows
  (`row + rows - 1 > 3`): the overflowing part is clipped and marked red. The layout never refuses to render.
- Line order of `@view` no longer matters for its position, only for the order of the remaining controls.
- A device can have many views, each class an entry point the editor can jump to. Several views are
  independent instances (own iframe each), they coordinate only through params, collections and streams, never
  directly, the same rule as view and processor.

### 4.1 Larger window

A script can open a bigger editor (full pattern editor, large spectrum, wavetable drawing) in a floating window,
or a native window on desktop.

```
// @window 900 520              class View in a window
// @window EditorView 900 520   class EditorView in a window
```

- Declares a window and its initial size in CSS px, the optional first token names the class (default `View`).
  Resizable, the last size is per device and saved like WCLAP window sizes. Many windows per device are allowed.
- Opened from a window button in the device header (one menu entry per declared window), or from any view with
  `host.openWindow(name?)`. `host.closeWindow(name?)` closes it. Opening an already open window focuses it.
- A class can serve both: `// @view View 10` plus `// @window View 900 520` instantiates the same class twice,
  `host.mode` tells it `"inline"` or `"window"`. Both instances read and write the same boxes, so they stay in
  sync without any code (draw a step in the window, the inline grid updates).
- A `@window` without `@view` is valid: no inline element, only the header button (a big editor that does not
  cost grid space).
- Where it opens:
  1. Browser: `FloatingWindow` inside the studio surface, exactly like WCLAP plugin GUIs (`WclapWindows.tsx`).
  2. Desktop (Tauri): a native child window hosting the same sandboxed page.
  3. Later, browser: Document Picture-in-Picture (Chrome) for a real OS window that floats above the studio
     (second monitor). `FloatingWindow` stays the browser default, PiP is a later option.
- Window lifecycle: closes when the device is deleted or the project closes. Not reopened on project load, same
  as WCLAP windows today.
- Rendering stays isolated: the window is just a bigger iframe with the same CSP, port and validation.

Reuse: `WclapWindows.tsx` already hosts third-party pages in iframes inside `FloatingWindow` with a separate frame
origin (`VITE_WCLAP_ORIGIN`), validated frame messages, key / wheel / context-menu forwarding and a message size
cap. The script view runtime should share that frame host (frame page, message guard, key forwarding, window
size persistence) instead of building a second one. The inline view uses the same frame page with a
`srcdoc`-built script instead of a bundle URL.

## 5. The view API (the `host` object, typed for Monaco)

```ts
interface ViewHost {
    readonly root: HTMLElement                              // document.body of the iframe
    readonly mode: "inline" | "window"
    readonly params: Record<string, ViewParam>
    readonly data: Record<string, ViewCollection>
    readonly streams: Record<string, ViewStream>
    readonly preview: ViewPreview
    edit(procedure: () => void): void                       // one transaction, one undo step
    gesture(): {edit(procedure: () => void): void, end(): void} // a drag, one undo step (mark / modify / mark)
    send(message: unknown): void                            // structured clone, size capped, not persisted
    openWindow(name?: string): void                         // a declared @window class, default "View"
    closeWindow(name?: string): void
    color(name: string): string
}
interface ViewParam {
    readonly label: string
    readonly value: number                                  // mapped (Hz, s, int)
    set(value: number): void                                // like a knob, respects automation
    subscribe(observer: (value: number) => void): Terminable
}
interface ViewCollection {
    readonly length: number
    get(index: number): Readonly<Record<string, number>>
    set(index: number, fields: Record<string, number>): void
    insert(index: number, fields?: Record<string, number>): void
    remove(index: number): void
    subscribe(observer: () => void): Terminable             // after any record change, coalesced per frame
}
interface ViewStream {
    subscribe(observer: (values: Float32Array) => void): Terminable
}
```

`class View { constructor(host) {...} }`. An optional `terminate()` is called before teardown as a courtesy hook
(flush transient state), never as a cleanup duty. The `Terminable` a `subscribe` returns is only for dropping a
subscription while the view lives. Writes outside `edit` / `gesture` are rejected with an error in the device
error icon.

## 6. Example A: Step Arp (Spielwerk)

```js
// @label Step Arp
// @param rate    120  30  480  int
// @param mode    0    0   2    int
// @param octaves 1    1   4    int
// @view 2 1 10 3
// @collection steps 16
// @field steps.on        true
// @field steps.velocity  0.8   0    1   linear
// @field steps.gate      0.5   0.05 1   linear
// @field steps.transpose 0    -12  12   int  st
// @stream step 1

class Processor {
    rate = 120
    mode = 0
    octaves = 1
    held = []
    paramChanged(name, value) {
        if (name === "rate") this.rate = value
        if (name === "mode") this.mode = value
        if (name === "octaves") this.octaves = value
    }
    reset() {
        this.held = []
        this.streams.step[0] = -1
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate) {
                this.held.push(event)
                this.held.sort((left, right) => left.pitch - right.pitch)
            } else {
                this.held = this.held.filter(note => note.id !== event.id)
            }
        }
        const steps = this.data.steps
        if (this.held.length === 0 || steps.length === 0) return
        const count = this.held.length * this.octaves
        let index = Math.ceil(block.from / this.rate)
        let position = index * this.rate
        while (position < block.to) {
            const stepIndex = index % steps.length
            const step = steps[stepIndex]
            this.streams.step[0] = stepIndex
            if (step.on) {
                const order = this.#order(index, count)
                const source = this.held[order % this.held.length]
                yield {
                    position,
                    duration: Math.max(1, Math.floor(this.rate * step.gate)),
                    pitch: source.pitch + Math.floor(order / this.held.length) * 12 + step.transpose,
                    velocity: source.velocity * step.velocity,
                    cent: source.cent
                }
            }
            position = ++index * this.rate
        }
    }
    #order(index, count) {
        if (this.mode === 0) return index % count
        if (this.mode === 1) return count - 1 - index % count
        const cycle = Math.max(1, count * 2 - 2)
        const phase = index % cycle
        return phase < count ? phase : cycle - phase
    }
}

class View {
    current = -1
    gesture = null
    constructor(host) {
        this.host = host
        this.canvas = document.createElement("canvas")
        this.canvas.style.cssText = "width: 100%; height: 100%; display: block; touch-action: none"
        host.root.append(this.canvas)
        host.data.steps.subscribe(() => this.draw())
        host.streams.step.subscribe(values => {
            if (values[0] === this.current) return
            this.current = values[0]
            this.draw()
        })
        new ResizeObserver(() => this.draw()).observe(this.canvas)
        this.canvas.addEventListener("pointerdown", event => this.press(event))
        this.canvas.addEventListener("pointermove", event => this.drag(event))
        this.canvas.addEventListener("pointerup", () => this.release())
    }
    locate(event) {
        const bounds = this.canvas.getBoundingClientRect()
        const steps = this.host.data.steps
        const index = Math.min(steps.length - 1, Math.floor((event.clientX - bounds.left) / bounds.width * steps.length))
        const velocity = 1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / (bounds.height - 12)))
        return {index, velocity, onToggleRow: event.clientY - bounds.top > bounds.height - 12}
    }
    press(event) {
        const {index, velocity, onToggleRow} = this.locate(event)
        const steps = this.host.data.steps
        if (onToggleRow) {
            this.host.edit(() => steps.set(index, {on: steps.get(index).on ? 0 : 1}))
            return
        }
        this.canvas.setPointerCapture(event.pointerId)
        this.gesture = this.host.gesture()
        this.gesture.edit(() => steps.set(index, {velocity}))
    }
    drag(event) {
        if (this.gesture === null) return
        const {index, velocity} = this.locate(event)
        this.gesture.edit(() => this.host.data.steps.set(index, {velocity}))
    }
    release() {
        if (this.gesture === null) return
        this.gesture.end()
        this.gesture = null
    }
    draw() {
        const {canvas, host} = this
        const ratio = devicePixelRatio
        canvas.width = canvas.clientWidth * ratio
        canvas.height = canvas.clientHeight * ratio
        const context = canvas.getContext("2d")
        context.scale(ratio, ratio)
        const width = canvas.clientWidth, height = canvas.clientHeight - 12
        const steps = host.data.steps
        const cell = width / steps.length
        for (let index = 0; index < steps.length; index++) {
            const step = steps.get(index)
            const x = index * cell
            context.fillStyle = index === this.current ? host.color("cream") : host.color("shadow")
            context.fillRect(x + 1, 0, cell - 2, height)
            context.fillStyle = step.on ? host.color("blue") : host.color("gray")
            context.fillRect(x + 1, height * (1 - step.velocity), cell - 2, height * step.velocity)
            context.fillStyle = step.on ? host.color("orange") : host.color("dark")
            context.fillRect(x + 1, height + 3, cell - 2, 8)
        }
    }
}
```

## 7. Example B: Harmonic Synth with spectrum and preview keys (Apparat)

```js
// @label Harmonic Synth
// @param attack  0.005 0.001 2   exp  s
// @param release 0.3   0.01  4   exp  s
// @view 2 1 12 3
// @collection partials
// @field partials.level 0 0 1 linear
// @record partials level=1
// @record partials level=0.5
// @record partials level=0.33
// @record partials level=0.25
// @record partials level=0.2
// @record partials level=0.16
// @record partials level=0.14
// @record partials level=0.12
// @stream spectrum 512 fft

const TABLE_SIZE = 2048

class Processor {
    voices = []
    attack = 0.005
    release = 0.3
    table = new Float32Array(TABLE_SIZE)
    paramChanged(name, value) {
        if (name === "attack") this.attack = value
        if (name === "release") this.release = value
    }
    dataChanged(name) {
        if (name !== "partials") return
        const table = new Float32Array(TABLE_SIZE)
        this.data.partials.forEach((partial, index) => {
            const harmonic = index + 1
            const gain = partial.level
            for (let sample = 0; sample < TABLE_SIZE; sample++) {
                table[sample] += gain * Math.sin(2 * Math.PI * harmonic * sample / TABLE_SIZE)
            }
        })
        const peak = table.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
        if (peak > 0) table.forEach((value, sample) => table[sample] = value / peak)
        this.table = table
    }
    noteOn(pitch, velocity, cent, id) {
        const frequency = 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)
        this.voices.push({id, gate: true, level: 0, velocity, phase: 0, step: frequency * TABLE_SIZE / sampleRate})
    }
    noteOff(id) {
        for (const voice of this.voices) if (voice.id === id) voice.gate = false
    }
    reset() {
        this.voices.length = 0
    }
    process(output, block) {
        const [outL, outR] = output
        const table = this.table
        const rise = 1 / (this.attack * sampleRate)
        const fall = Math.exp(-1 / (this.release * sampleRate))
        for (let s = block.s0; s < block.s1; s++) {
            let sum = 0
            for (const voice of this.voices) {
                voice.level = voice.gate ? Math.min(1, voice.level + rise) : voice.level * fall
                const position = voice.phase | 0
                const fraction = voice.phase - position
                const value = table[position] + (table[(position + 1) % TABLE_SIZE] - table[position]) * fraction
                sum += value * voice.level * voice.velocity * 0.25
                voice.phase = (voice.phase + voice.step) % TABLE_SIZE
            }
            outL[s] = sum
            outR[s] = sum
        }
        this.voices = this.voices.filter(voice => voice.gate || voice.level > 0.0001)
        this.streams.spectrum.write(outL, block.s0, block.s1)
    }
}

const KEYS = 24
const BASE_PITCH = 48

class View {
    spectrum = new Float32Array(512)
    held = -1
    gesture = null
    constructor(host) {
        this.host = host
        host.root.innerHTML = `
            <style>
                body { margin: 0; display: grid; grid-template-rows: 1fr 1fr 16px; gap: 2px; height: 100vh }
                canvas { width: 100%; height: 100%; display: block; touch-action: none }
            </style>`
        this.bars = this.#canvas()
        this.analyser = this.#canvas()
        this.keys = this.#canvas()
        host.data.partials.subscribe(() => this.drawBars())
        host.streams.spectrum.subscribe(magnitudes => this.analyse(magnitudes))
        new ResizeObserver(() => this.drawAll()).observe(host.root)
        this.bars.addEventListener("pointerdown", event => this.pressBar(event))
        this.bars.addEventListener("pointermove", event => this.dragBar(event))
        this.bars.addEventListener("pointerup", () => this.releaseBar())
        this.keys.addEventListener("pointerdown", event => this.pressKey(event))
        this.keys.addEventListener("pointerup", () => this.releaseKey())
        this.keys.addEventListener("pointerleave", () => this.releaseKey())
    }
    #canvas() {
        const canvas = document.createElement("canvas")
        this.host.root.append(canvas)
        return canvas
    }
    #prepare(canvas) {
        const ratio = devicePixelRatio
        canvas.width = canvas.clientWidth * ratio
        canvas.height = canvas.clientHeight * ratio
        const context = canvas.getContext("2d")
        context.scale(ratio, ratio)
        return {context, width: canvas.clientWidth, height: canvas.clientHeight}
    }
    #partialAt(event) {
        const bounds = this.bars.getBoundingClientRect()
        const count = this.host.data.partials.length
        const index = Math.min(count - 1, Math.floor((event.clientX - bounds.left) / bounds.width * count))
        const level = 1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
        return {index, level}
    }
    pressBar(event) {
        this.bars.setPointerCapture(event.pointerId)
        this.gesture = this.host.gesture()
        this.dragBar(event)
    }
    dragBar(event) {
        if (this.gesture === null) return
        const {index, level} = this.#partialAt(event)
        this.gesture.edit(() => this.host.data.partials.set(index, {level}))
    }
    releaseBar() {
        if (this.gesture === null) return
        this.gesture.end()
        this.gesture = null
    }
    pressKey(event) {
        const bounds = this.keys.getBoundingClientRect()
        this.held = BASE_PITCH + Math.floor((event.clientX - bounds.left) / bounds.width * KEYS)
        this.host.preview.noteOn(this.held, 0.8)
        this.drawKeys()
    }
    releaseKey() {
        if (this.held === -1) return
        this.host.preview.noteOff(this.held)
        this.held = -1
        this.drawKeys()
    }
    analyse(magnitudes) {
        for (let bin = 0; bin < magnitudes.length; bin++) {
            this.spectrum[bin] = Math.max(this.spectrum[bin] * 0.85, magnitudes[bin])
        }
        this.drawSpectrum()
    }
    drawAll() {
        this.drawBars()
        this.drawSpectrum()
        this.drawKeys()
    }
    drawBars() {
        const {context, width, height} = this.#prepare(this.bars)
        const partials = this.host.data.partials
        const cell = width / partials.length
        context.fillStyle = this.host.color("blue")
        for (let index = 0; index < partials.length; index++) {
            const level = partials.get(index).level
            context.fillRect(index * cell + 1, height * (1 - level), cell - 2, height * level)
        }
    }
    drawSpectrum() {
        const {context, width, height} = this.#prepare(this.analyser)
        context.strokeStyle = this.host.color("orange")
        context.beginPath()
        for (let bin = 1; bin < this.spectrum.length; bin++) {
            const x = Math.log(bin) / Math.log(this.spectrum.length) * width
            const decibel = 20 * Math.log10(this.spectrum[bin] + 1e-9)
            const y = height * Math.min(1, -decibel / 72)
            bin === 1 ? context.moveTo(x, y) : context.lineTo(x, y)
        }
        context.stroke()
    }
    drawKeys() {
        const {context, width, height} = this.#prepare(this.keys)
        const cell = width / KEYS
        for (let key = 0; key < KEYS; key++) {
            const black = [1, 3, 6, 8, 10].includes(key % 12)
            const pressed = BASE_PITCH + key === this.held
            context.fillStyle = pressed ? this.host.color("blue") : this.host.color(black ? "dark" : "cream")
            context.fillRect(key * cell + 0.5, 0, cell - 1, height)
        }
    }
}
```

## 8. Phases

1. Top-level rule: scanner + deep freeze, active only for scripts with `class View` / `@view` / `@window`
   (finding 1), so no migration. Tests over every shipped example plus the edge-case suite from the prototype.
2. `@view` slot + sandboxed iframe runtime + `host.params` + theme + key forwarding. Example: a param-driven
   envelope display.
3. `@collection` / `@field`: boxes, reconcile, view collection API with `edit` / `gesture`. Undo, Live-room,
   clipboard and delete-cascade tests.
4. Engine: `observe_script_records`, `host_script_value` / `host_script_data`, bridge cache + `this.data` +
   `dataChanged`. Example A without the step highlight, rendered headless in node (core-wasm harness): editing a
   step changes the render, a hot-swap keeps the data.
5. `@stream` (value, ring, fft) over device live data, `host.preview`. Example A complete, Example B.
6. `@buffer` bulk data (bytes box), `send` / `message`.
7. `@window`: header button, `host.openWindow()`, `mode`, FloatingWindow in the browser, native window in Tauri,
   later Document Picture-in-Picture.

## 9. Dry run findings (2026-10-21)

Walked every phase against the real touch points, plus a scanner / freeze prototype in node
(21 shipped examples, both plan scripts, 22 edge cases).

1. Opt-in enforcement. A processor-only script has no second realm, so no sharing hazard. The top-level rule,
   strict mode and freeze apply only when the script declares `class View`, `@view` or `@window`. Existing scripts
   stay bit-identical, top-level `let` in them keeps working, no migration needed.
2. Strict mode is already live. The worklet registers scripts via `audioWorklet.addModule` (a module, always
   strict). The offline worker evaluates the same code with `new Function(code)()` (`offline-worker.ts:355`,
   sloppy). A `"use strict"` inside the wrapper aligns offline with live, any script that runs live survives it.
3. Freeze: constructors only, not prototypes (override mistake breaks `this.draw = this.draw.bind(this)`).
   `Map` / `Set` contents survive `Object.freeze`, so they are rejected. Empty typed arrays freeze fine.
4. Escape routes the scanner + freeze do NOT catch (both verified):
   - `class Counter { static #count = 0 }`: private statics are not properties, freeze cannot reach them.
   - `const next = (() => { let count = 0; return () => ++count })()`: closure state inside a const initializer.
   Closed in section 1.1 without acorn and without a call whitelist: private static fields are rejected by the
   scanner (class body depth), closures produced by a call are rejected by the scanner verdict plus the runtime
   walk. Public static fields stay allowed (frozen, writes throw).
5. Scanner prototype (`scan.mjs` in the session scratchpad, ~150 lines): all shipped examples and both plan scripts
   pass. Edge cases pass (multi-line const, leading-dot and ternary continuations, regex containing `{`, nested
   template literals, `let` in comments and inside classes, division vs regex, async / generator functions,
   IIFE, `if`, `export`, `const A = 1; let b`). The single deviation, `const A = 1\n(function () {})()`, is
   rejected. That is JS's own ASI hazard (it parses as calling `1`), rejecting it is better than passing it.
6. Editor rebuild destroys the iframe. `ScriptDeviceEditor.scheduleRebuild` runs on every add / remove in the
   param, sample and sidechain hubs plus every code change, and `rebuildControls` calls `replaceChildren()`. A
   compile that adds 5 params would reload the view 6 times, and moving an iframe in the DOM reloads it anyway
   (`moveBefore` preserves it, Chrome only). Fix: coalesce rebuilds to one per transaction, keep the iframe as a
   stable child of its section's grid, recreate it only when the script `update` counter changes. Explicit
   placement makes this simple: a view's position comes from its `grid-column` / `grid-row`, not its DOM position,
   so the rebuild replaces the auto-flow controls around the iframe and never moves it. Views inside a `@group`
   live in the group's own grid, so a rebuild keeps group containers whose section did not change (diff sections
   by label + items). Where the section really changed, use `moveBefore` when available, else accept one reload
   (state lives in boxes, only transient view state is lost).
7. Frame host reuse is partial. WCLAP pages load from a separate origin page (`wclap-frame.html` + service
   worker, empty origin in dev), script views are sandboxed `srcdoc` with an opaque origin. Inbound checks become
   `event.source === iframe.contentWindow` with origin `"null"`, the port goes out with target `"*"`. Reusable:
   `FloatingWindow`, key / wheel / context-menu forwarding, the message-guard pattern, window size persistence.
8. Cross-origin isolation. The studio runs COOP `same-origin` + COEP `require-corp` (`index.html`,
   `vite.config.ts`). `srcdoc` documents inherit the policy container, but a sandboxed opaque-origin `srcdoc` under
   COEP must be verified in Chrome, Firefox, Safari, WebView2 and WKWebView (Tauri). One spike page before phase 2.
9. Preview notes can stick. The host tracks held preview pitches per view instance and sends `note-off` for all
   of them on iframe teardown (recompile, window close, device removal), never through the script.
10. Rebind risk. Verify that adding / removing a child under a script hub does not re-run the device `init`:
    `init` calls `script_create`, which replaces the bridge, so the Processor would be rebuilt and every voice
    lost on each step insert from the view. Records need the lightest path, never a device rebind.
11. Copy and delete. `BoxGraph.dependenciesOf` follows incoming mandatory pointers, so record and value boxes
    (mandatory `owner`) should travel with device copies and be deleted with the device. Test both levels
    (device, record, value) in `DevicesClipboardHandler.test.ts` and the composite copy paths.
12. Never scan on load. `ScriptCompiler.load` runs for every script device at project load. The rule is enforced
    on compile only, so a future, stricter scanner can never refuse to load a saved project.
13. Monaco: shared `javascriptDefaults`, semantic validation off, only `sampleRate` declared. The view API needs an
    extra lib (`ViewHost` and friends as global types) plus `/** @param {ViewHost} host */` in the examples. Scan
    errors need line markers, today compile errors only reach the device error icon.

### 9.1 Implementation dry run (2026-10-21, branch `script-views`)

1. Template: commit f6192f2b8 (`@sidechain`) is the end-to-end path for a new script collection: schema +
   `Pointers` (append only), Rust registry, `observe_*_collection_field` export per crate, `DeviceReg` field via
   a `device_set_*` setter (no `device_register` signature change), linker + engine exports, bridge, compiler
   reconcile, editor, manual pages, starter prompts, examples.
2. Rebind risk (finding 10) is a non-issue: a hub add / remove calls `invalidate`, which ends in `rebind_one`
   (params only). The device `init` never re-runs, so the Processor survives record inserts.
3. Records hub is field 14 on all three device boxes (Spielwerk has no 13, the same key everywhere is simpler).
4. Data delivery simplified: no value deltas. Any record / value change marks the device's data dirty, the engine
   flushes ONE snapshot per collection at the update clock (next to `params_dirty`), through a new device export
   `data_changed(state_ptr, collection, ptr, records, fields)` that forwards to `host_script_data`. Values are
   `f32` record-major in field-index order, a missing value box is `NaN` and the bridge fills the `@field` default.
   Coalescing per update also means a half-applied transaction is never delivered.
5. Gesture correction: `beginModification` keeps one graph transaction open, so the engine would hear nothing
   until release. Views use the knob pattern instead: `editing.mark()` on start, `editing.modify(fn, false)` per
   move, `editing.mark()` on end = one undo step with live updates (`RelativeUnitValueDragging.tsx`).
6. Streams: `LiveStreamBroadcaster.broadcastFloats(address, values, before)` takes any JS `Float32Array`, and
   `before(hasSubscribers)` gives `.active` for free. `ScriptBridges` gets the broadcaster from `processor.ts`
   (offline worker: its own broadcaster, nobody subscribes). Ring and fft streams keep their ring JS-side and
   linearize into the published array inside `before`.
7. The worklet has no JS box graph (sync goes straight to Rust), so data MUST go through the Rust engine.
8. The view runtime is a raw `.js` file imported with `?raw` (like the examples): an opaque-origin `srcdoc` can
   import nothing, so the runtime carries its own small radix-2 FFT instead of lib-dsp.

## 10. Decisions (2026-10-21)

1. Many views per device, named by class, default `View`, placed explicitly by cell (section 4).
2. Seeded records with `@record` lines (section 3.1).
3. No latency alignment for streams.
4. `font-src` allows the studio origin.
5. Views may write params (like a knob, respects automation).
6. Collection values are `float32`.
7. Script windows do not reopen on project load, same as WCLAP windows today.
8. `FloatingWindow` first, Document Picture-in-Picture later.
9. A changed collection declaration grows and shrinks, surviving records keep their data (section 3.1).
10. Escape routes closed as far as possible without being intrusive (section 1.1).
11. `@view` is allowed inside `@group`, coordinates relative to the group (section 4, finding 6).
12. Views declare column, row, columns and rows, the remaining controls fill the free cells, overlaps are shown
    with a red rectangle (2026-10-21).

## 11. Open questions

None yet. New ones go here as implementation surfaces them.
