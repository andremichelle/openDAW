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
   `SCALES.push(...)`), destructuring `const`, `export` / `import`. Example message:
   `Line 4: top-level 'let current' would exist separately in the processor and the view. Move it into the class.`
2. Runtime freeze, in both realms. The compiler appends, after the user code inside the wrapper, a deep
   `Object.freeze` over every top-level `const` value, every top-level function and every class (constructor and
   prototype). So:
   - `SCALES.push(7)` throws, `Helper.cache = x` and `static counter` writes throw (the wrapper is strict mode).
   - A top-level `const TABLE = new Float32Array(2048)` fails at compile with
     `typed arrays are mutable, create 'TABLE' in the constructor` (freeze cannot freeze a non-empty typed array,
     which is exactly the right verdict).
   - Duplicated immutable constants and pure helpers in both realms are fine, they cannot diverge.
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

Decision: one sandboxed `<iframe>` per device view.

- `sandbox="allow-scripts"` WITHOUT `allow-same-origin`: opaque origin, no access to `parent`, studio DOM,
  cookies, `localStorage`, IndexedDB, OPFS, service worker. No `allow-popups`, `allow-modals`, `allow-forms`,
  `allow-top-navigation`.
- `srcdoc` built by the host: CSP meta `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob:` so `fetch`, websockets, remote images and fonts are blocked (no exfiltration of project data).
- Cannot flow into the studio UI: the iframe IS the clip rect. The host sizes it to its grid slot, the script draws
  inside, overflow is physically impossible.
- One channel: the host transfers a `MessagePort` at boot. Every inbound message is validated against the manifest
  (known collection / field / param names, numeric values, clamped to declared min/max, size caps, rate limit per
  frame). The host never evaluates anything it receives. Names checked with Maps, `__proto__` rejected as today.
- The view can only reach its own device: the host resolves names to THIS device's boxes, there is no address,
  uuid or box in the API.
- Recompile = new `srcdoc` = fresh realm. Nothing is lost because all persistent state lives in boxes.
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

- `@field` reuses the `@param` token grammar exactly (default min max mapping unit), one parser.
- `16` is the INITIAL record count created on first compile, not a limit. Records can be inserted / removed.
- Values are numbers (int, float, bool), mapped and clamped like params. No strings in v1.
- Boxes, hub + child boxes as everywhere else:
  - `ScriptRecordBox { owner -> device.records, collection: string, index: int32 }`
  - `ScriptValueBox  { owner -> record.values, field: string, value: float32 }`
  - Fine-grained: one value edit = one field change, merges in Live rooms, undo per gesture.
- Reconcile on compile like `reconcileParameters`: new field = value boxes with defaults in every record, removed
  field = value boxes deleted, changed min/max = values clamped, removed collection = records deleted.
- Processor side: `this.data.steps` is an array of frozen plain objects `{on, velocity, transpose}`, rebuilt after
  the transaction (update clock, never mid-block). `dataChanged(name)` is called after a rebuild and once after
  construction. The processor never writes data (the audio thread must not create transactions, and composite
  replicas would write N times).
- TS engine: the adapter in the worklet reads the box replica directly.
- WASM engine: the device crate binds the `records` hub (like params / samples), on change writes a compact
  snapshot (record count, field count, f32 values in manifest order) and calls a new
  `host_script_data(handle, collection, ptr, records, fields)`. `// WASM CONTRACT:` markers on both sides.

Later (phase 6), bulk data: `// @buffer wave 2048` = `ScriptBufferBox { owner, label, data: bytes }`, replaced
whole per edit, for drawable wavetables or curves where one box per value would be absurd.

### 3.2 Streams (processor to view)

```
// @stream step 1          value: fixed Float32Array the processor overwrites
// @stream scope 1024 ring ring: the processor appends blocks, the view receives the latest 1024 in order
```

- Processor: `this.streams.step[0] = index`, `this.streams.scope.write(channel, s0, s1)`.
- Shipped over the existing device live-data path (LiveStream, fixed-size packets, which fits the fixed declared
  length). The view receives at most one packet per animation frame.
- Composite replicas: only the first instance broadcasts.
- Offline render: streams are not shipped.

### 3.3 Preview

`host.preview.noteOn(pitch, velocity)` / `noteOff(pitch)` routes through the existing engine `NoteSignal` of the
device's audio unit (Apparat, and Spielwerk through its downstream instrument). No processor code needed.

## 4. Layout (issue 4)

The three-row grid stays. One new item:

```
// @view 10
```

- Takes a slot in directive order, exactly like a param or sample, also inside a `@group`.
- Always spans all 3 rows (11em = 3 × 3.5em + 2 × 0.25em), `10` = width in grid columns
  (10 × 3.5em + 9 × 0.25em gaps). `grid-row: span 3` so it always starts a fresh column.
- Exactly one view per device in v1.
- The iframe follows the UI zoom because its size is in em, the view reacts with a native `ResizeObserver`.

### 4.1 Larger window

A script can open a bigger editor (full pattern editor, large spectrum, wavetable drawing) in a floating window,
or a native window on desktop.

```
// @window 900 520
```

- Declares that the device has a window and its initial size in CSS px. Resizable, the last size is per device
  and saved like WCLAP window sizes.
- Opened from a window button in the device header (always there when `@window` is declared), or from the inline
  view with `host.openWindow()`. `host.closeWindow()` closes it. Opening an already open window focuses it.
- The SAME `class View` is instantiated a second time in its own sandboxed iframe, with `host.mode === "window"`
  (inline instance: `"inline"`). One class, two layouts, so no new entry point. Both instances read and write the
  same boxes, so they stay in sync without any code (draw a step in the window, the inline grid updates).
- A `@window` without `@view` is valid: no inline element, only the header button (a big editor that does not
  cost grid space).
- Where it opens:
  1. Browser: `FloatingWindow` inside the studio surface, exactly like WCLAP plugin GUIs (`WclapWindows.tsx`).
  2. Desktop (Tauri): a native child window hosting the same sandboxed page.
  3. Later, browser: Document Picture-in-Picture (Chrome) for a real OS window that floats above the studio
     (second monitor).
- Window lifecycle: closes when the device is deleted or the project closes, reopens on project load if it was
  open (optional, open question).
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
    readonly dsp: {fft(real: Float32Array, imag: Float32Array): void}
    edit(procedure: () => void): void                       // one transaction, one undo step
    gesture(): {edit(procedure: () => void): void, end(): void} // a drag, one undo step at the end (beginModification)
    send(message: unknown): void                            // structured clone, size capped, not persisted
    openWindow(): void                                      // requires // @window
    closeWindow(): void
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

`class View { constructor(host) {...}; terminate() {...} }`. Writes outside `edit` / `gesture` are rejected with an
error in the device error icon.

## 6. Example A: Step Arp (Spielwerk)

```js
// @label Step Arp
// @param rate    120  30  480  int
// @param mode    0    0   2    int
// @param octaves 1    1   4    int
// @view 10
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
        this.subscriptions = [
            host.data.steps.subscribe(() => this.draw()),
            host.streams.step.subscribe(values => {
                if (values[0] === this.current) return
                this.current = values[0]
                this.draw()
            })
        ]
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
    terminate() {
        this.subscriptions.forEach(subscription => subscription.terminate())
    }
}
```

## 7. Example B: Harmonic Synth with spectrum and preview keys (Apparat)

```js
// @label Harmonic Synth
// @param attack  0.005 0.001 2   exp  s
// @param release 0.3   0.01  4   exp  s
// @view 12
// @collection partials 16
// @field partials.level 0.5 0 1 linear
// @stream scope 1024 ring

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
            const gain = partial.level / harmonic
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
        this.streams.scope.write(outL, block.s0, block.s1)
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
        this.real = new Float32Array(1024)
        this.imag = new Float32Array(1024)
        this.subscriptions = [
            host.data.partials.subscribe(() => this.drawBars()),
            host.streams.scope.subscribe(samples => this.analyse(samples))
        ]
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
    analyse(samples) {
        const {real, imag, spectrum} = this
        for (let index = 0; index < samples.length; index++) {
            real[index] = samples[index] * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (samples.length - 1)))
            imag[index] = 0
        }
        this.host.dsp.fft(real, imag)
        for (let bin = 0; bin < spectrum.length; bin++) {
            const magnitude = Math.hypot(real[bin], imag[bin]) / samples.length
            spectrum[bin] = Math.max(spectrum[bin] * 0.85, magnitude)
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
    terminate() {
        this.releaseKey()
        this.subscriptions.forEach(subscription => subscription.terminate())
    }
}
```

## 8. Phases

1. Top-level rule: scanner + deep freeze in the existing wrappers, tests over every shipped example. Existing
   examples that break the rule are fixed in the same pass (nothing must break: audit which presets in the wild
   use top-level `let`, decide a migration before enforcing). Shipped examples already pass: only top-level
   `const` numbers (alienator) and a `const` array of functions (deminix).
2. `@view` slot + sandboxed iframe runtime + `host.params` + theme + key forwarding. Example: a param-driven
   envelope display.
3. `@collection` / `@field`: boxes, reconcile, TS engine `this.data` + `dataChanged`, view collection API with
   `edit` / `gesture`. Example A without the step highlight. Undo + Live-room tests.
4. WASM engine: `records` hub binding in the three crates, `host_script_data`, parity tests vs the TS engine
   (render Example A in node through both engines, bit-identical).
5. `@stream` (value + ring) over device live data, `host.preview`, `host.dsp.fft`. Example A complete, Example B.
6. `@buffer` bulk data (bytes box), `send` / `message`.
7. `@window`: header button, `host.openWindow()`, `mode`, FloatingWindow in the browser, native window in Tauri,
   later Document Picture-in-Picture.

## 9. Open questions

1. Is one view per device enough for v1, or do we need named views (`// @view pattern 8`, `// @view scope 4`)?
2. Seeded collection defaults (first partial 1, rest 0) are not expressible with one default per field.
   Allow an `@record` line per index, or accept uniform defaults?
3. Stream timing: the processor renders ahead, the step highlight leads the audio by the output latency.
   Delay stream packets by the reported output latency on the host side?
4. Fonts inside the iframe: CSP blocks the studio fonts. Inline the UI font as a data URL in `srcdoc`, or allow
   `font-src` for the studio origin?
5. Should a view be allowed to write params at all, or read only (knobs stay the only writers)?
6. Field values as `float32` (ints exact up to 2^24) or `float64`?
7. Reopen script windows on project load if they were open when saved?
8. Document Picture-in-Picture as the browser default for `@window` where available, or FloatingWindow first?
