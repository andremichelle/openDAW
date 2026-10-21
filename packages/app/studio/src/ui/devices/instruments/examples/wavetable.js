// @label Wavetable
// @param position 0     0     1    linear
// @param bend     0     0     1    linear
// @param unison   1     1     7    int
// @param detune   12    0     50   linear ct
// @param attack   0.005 0.001 2    exp    s
// @param release  0.3   0.01  4    exp    s
// @view 3 1 10 3
// @window Editor 900 520
// @buffer table 16384
// @stream frame 1

const FRAMES = 64
const SIZE = 256

// one frame per row, every frame normalized to a peak of 1, shape(t, x): t = frame 0..1, x = phase 0..1
function buildTable(shape) {
    const table = new Float32Array(FRAMES * SIZE)
    for (let frame = 0; frame < FRAMES; frame++) {
        const t = frame / (FRAMES - 1)
        let peak = 0
        for (let index = 0; index < SIZE; index++) {
            const value = shape(t, index / SIZE)
            table[frame * SIZE + index] = value
            peak = Math.max(peak, Math.abs(value))
        }
        if (peak > 0) for (let index = 0; index < SIZE; index++) table[frame * SIZE + index] /= peak
    }
    return table
}

function harmonics(x, count, amplitude) {
    let sum = 0
    for (let harmonic = 1; harmonic <= count; harmonic++) sum += amplitude(harmonic) * Math.sin(2 * Math.PI * harmonic * x)
    return sum
}

const GENERATORS = [
    ["Sine → Saw", (t, x) => harmonics(x, 32, harmonic => harmonic === 1 ? 1 : t / harmonic)],
    ["Harmonics", (t, x) => harmonics(x, 1 + Math.floor(t * 31), harmonic => 1 / harmonic)],
    ["Pulse", (t, x) => x < 0.5 - t * 0.45 ? 1 : -1],
    ["Formant", (t, x) => Math.sin(2 * Math.PI * x * (1 + t * 15)) * (0.5 - 0.5 * Math.cos(2 * Math.PI * x))],
    ["Fold", (t, x) => Math.sin(Math.sin(2 * Math.PI * x) * (1 + t * 8))]
]

function defaultTable() {
    return buildTable(GENERATORS[0][1])
}

function isEmpty(table) {
    return table.every(value => value === 0)
}

const SMOOTHING = 0.005 // seconds a position or bend change takes, a jump between frames would click
const MAX_UNISON = 7

// 4-point Hermite inside one frame, wrapping around the cycle
function hermite(table, offset, index, fraction) {
    const before = table[offset + (index + SIZE - 1) % SIZE]
    const current = table[offset + index]
    const next = table[offset + (index + 1) % SIZE]
    const after = table[offset + (index + 2) % SIZE]
    const c1 = 0.5 * (next - before)
    const c2 = before - 2.5 * current + 2 * next - 0.5 * after
    const c3 = 0.5 * (after - before) + 1.5 * (current - next)
    return ((c3 * fraction + c2) * fraction + c1) * fraction + current
}

// `frame` is fractional (0 to FRAMES - 1), neighbouring frames are crossfaded
function lookup(table, frame, phase) {
    const frameA = Math.min(FRAMES - 2, frame | 0)
    const blend = frame - frameA
    const position = phase * SIZE
    const index = position | 0
    const fraction = position - index
    const valueA = hermite(table, frameA * SIZE, index, fraction)
    const valueB = hermite(table, (frameA + 1) * SIZE, index, fraction)
    return valueA + (valueB - valueA) * blend
}

class Processor {
    voices = []
    position = 0
    bend = 0
    unison = 1
    detune = 12
    attack = 0.005
    release = 0.3
    smoothPosition = 0
    smoothBend = 0
    ratios = new Float64Array(MAX_UNISON)
    pans = new Float64Array(MAX_UNISON)
    table = defaultTable()
    constructor() {
        this.updateUnison()
    }
    paramChanged(label, value) {
        this[label] = value
        if (label === "unison" || label === "detune") this.updateUnison()
    }
    updateUnison() {
        const count = Math.round(this.unison)
        for (let index = 0; index < MAX_UNISON; index++) {
            const spread = count > 1 ? index / (count - 1) * 2 - 1 : 0
            this.ratios[index] = Math.pow(2, spread * this.detune / 1200)
            this.pans[index] = spread
        }
    }
    dataChanged(name) {
        if (name === "table") this.table = isEmpty(this.data.table) ? defaultTable() : this.data.table
    }
    noteOn(pitch, velocity, cent, id) {
        const frequency = 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)
        const phases = Float64Array.from({length: MAX_UNISON}, (entry, index) => index / MAX_UNISON)
        this.voices.push({id, velocity, step: frequency / sampleRate, phases, gate: true, level: 0})
    }
    noteOff(id) {
        for (const voice of this.voices) if (voice.id === id) voice.gate = false
    }
    reset() {
        for (const voice of this.voices) voice.gate = false
    }
    process(output, block) {
        const [outL, outR] = output
        const table = this.table
        const unison = Math.round(this.unison)
        const gain = (unison > 1 ? 0.2 : 0.1) / Math.sqrt(unison)
        const rise = 1 / (this.attack * sampleRate)
        const fall = Math.exp(-1 / (this.release * sampleRate))
        const coefficient = 1 - Math.exp(-1 / (SMOOTHING * sampleRate))
        for (let s = block.s0; s < block.s1; s++) {
            this.smoothPosition += (this.position - this.smoothPosition) * coefficient
            this.smoothBend += (this.bend - this.smoothBend) * coefficient
            const frame = this.smoothPosition * (FRAMES - 1)
            const exponent = 1 + this.smoothBend * 4
            for (const voice of this.voices) {
                voice.level = voice.gate ? Math.min(1, voice.level + rise) : voice.level * fall
                let left = 0, right = 0
                for (let index = 0; index < unison; index++) {
                    const phase = voice.phases[index]
                    const value = lookup(table, frame, exponent === 1 ? phase : Math.pow(phase, exponent))
                    left += value * (1 - this.pans[index])
                    right += value * (1 + this.pans[index])
                    voice.phases[index] = (phase + voice.step * this.ratios[index]) % 1
                }
                const amplitude = voice.level * voice.velocity * gain
                outL[s] += left * amplitude
                outR[s] += right * amplitude
            }
        }
        this.voices = this.voices.filter(voice => voice.gate || voice.level > 0.0001)
        this.streams.frame[0] = this.smoothPosition * (FRAMES - 1)
    }
}

// The isometric frame stack, drawn once into a cached canvas per table and size, the playing frame on top.
class Stack {
    constructor(host, canvas) {
        this.host = host
        this.canvas = canvas
        this.cache = document.createElement("canvas")
        this.table = defaultTable()
        this.frame = 0
        this.selected = -1
        this.dirty = true
    }
    setTable(table) {
        this.table = isEmpty(table) ? defaultTable() : table
        this.dirty = true
        this.draw()
    }
    setFrame(frame) {
        if (Math.abs(frame - this.frame) < 0.01) return
        this.frame = frame
        this.draw()
    }
    geometry(width, height) {
        const stepX = width * 0.3 / (FRAMES - 1)
        const stepY = height * 0.4 / (FRAMES - 1)
        const waveWidth = width - stepX * (FRAMES - 1) - 8
        const amplitude = (height - stepY * (FRAMES - 1)) * 0.38
        return {stepX, stepY, waveWidth, amplitude, baseline: height - amplitude - 4}
    }
    path(frame, width, height) {
        const {stepX, stepY, waveWidth, amplitude, baseline} = this.geometry(width, height)
        const x0 = 4 + frame * stepX, y0 = baseline - frame * stepY
        const path = new Path2D()
        for (let index = 0; index <= SIZE; index++) {
            const x = x0 + index / SIZE * waveWidth
            const y = y0 - this.table[frame * SIZE + index % SIZE] * amplitude
            index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)
        }
        return {path, x0, y0, x1: x0 + waveWidth}
    }
    renderCache(width, height, ratio) {
        this.cache.width = width * ratio
        this.cache.height = height * ratio
        const context = this.cache.getContext("2d")
        context.scale(ratio, ratio)
        context.lineWidth = 1
        for (let frame = FRAMES - 1; frame >= 0; frame -= 2) {
            const {path, x0, y0, x1} = this.path(frame, width, height)
            const area = new Path2D(path)
            area.lineTo(x1, y0)
            area.lineTo(x0, y0)
            context.fillStyle = this.host.color("panelBackground", 0.85)
            context.fill(area)
            context.strokeStyle = this.host.color("displayStroke", 0.12 + 0.33 * (1 - frame / FRAMES))
            context.stroke(path)
        }
        this.dirty = false
    }
    draw() {
        const ratio = devicePixelRatio
        const width = this.canvas.clientWidth, height = this.canvas.clientHeight
        if (width === 0 || height === 0) return
        if (this.dirty || this.cache.width !== width * ratio || this.cache.height !== height * ratio) this.renderCache(width, height, ratio)
        this.canvas.width = width * ratio
        this.canvas.height = height * ratio
        const context = this.canvas.getContext("2d")
        context.drawImage(this.cache, 0, 0)
        context.scale(ratio, ratio)
        const playing = Math.round(this.frame)
        if (this.selected >= 0 && this.selected !== playing) {
            context.strokeStyle = this.host.color("displayStroke", 0.6)
            context.setLineDash([2, 2])
            context.stroke(this.path(this.selected, width, height).path)
            context.setLineDash([])
        }
        const {path, x0, y0, x1} = this.path(playing, width, height)
        const area = new Path2D(path)
        area.lineTo(x1, y0)
        area.lineTo(x0, y0)
        const gradient = context.createLinearGradient(0, y0 - this.geometry(width, height).amplitude, 0, y0)
        gradient.addColorStop(0, this.host.color("displayStroke", 0.3))
        gradient.addColorStop(1, this.host.color("displayStroke", 0))
        context.fillStyle = gradient
        context.fill(area)
        context.strokeStyle = this.host.color("displayStroke", 1)
        context.lineWidth = 1
        context.stroke(path)
        context.font = "9px Rubik"
        context.fillStyle = "rgba(255, 255, 255, 0.2)"
        context.fillText(`Frame ${playing + 1}`, 6, 12)
    }
}

class View {
    gesture = null
    constructor(host) {
        this.host = host
        host.root.innerHTML = `
            <style>
                body { margin: 0; box-sizing: border-box; padding: 4px; height: 100vh; position: relative }
                canvas { width: 100%; height: 100%; display: block; border-radius: 4px; touch-action: none; cursor: ns-resize }
                button { position: absolute; top: 8px; right: 8px; font: inherit; font-size: 9px; color: var(--color-gray);
                    border: none; border-radius: 2px; padding: 1px 6px; cursor: pointer;
                    background: hsl(from var(--color-display-stroke) h s l / 0.1) }
                button:hover { background: hsl(from var(--color-display-stroke) h s l / 0.2) }
            </style>`
        const canvas = document.createElement("canvas")
        canvas.title = "Drag up and down to scan the table. Double-click opens the editor."
        const open = document.createElement("button")
        open.textContent = "Edit Table"
        open.addEventListener("click", () => host.openWindow("Editor"))
        host.root.append(canvas, open)
        this.stack = new Stack(host, canvas)
        this.stack.setTable(host.data.table.toArray())
        host.data.table.subscribe(() => this.stack.setTable(host.data.table.toArray()))
        host.params.position.subscribe(value => this.stack.setFrame(value * (FRAMES - 1)))
        host.streams.frame.subscribe(values => this.stack.setFrame(values[0]))
        new ResizeObserver(() => this.stack.draw()).observe(canvas)
        canvas.addEventListener("dblclick", () => host.openWindow("Editor"))
        canvas.addEventListener("pointerdown", event => {
            canvas.setPointerCapture(event.pointerId)
            this.gesture = host.gesture()
            this.start = {y: event.clientY, value: host.params.position.value}
        })
        canvas.addEventListener("pointermove", event => {
            if (this.gesture === null) return
            const value = Math.max(0, Math.min(1, this.start.value + (this.start.y - event.clientY) / 200))
            this.gesture.edit(() => host.params.position.set(value))
        })
        canvas.addEventListener("pointerup", () => {
            this.gesture?.end()
            this.gesture = null
        })
    }
}

// The window: generators, the stack, a large editor for the selected frame and a frame strip.
class Editor {
    selected = 0
    gesture = null
    last = null
    constructor(host) {
        this.host = host
        host.root.innerHTML = `
            <style>
                body { margin: 0; box-sizing: border-box; padding: 4px; height: 100vh; display: grid; gap: 4px;
                    grid-template-rows: 18px minmax(0, 1fr) 16px 12px; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) }
                nav { grid-column: 1 / -1; display: flex; gap: 4px; align-items: stretch }
                nav span { font-size: 8px; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255, 255, 255, 0.3);
                    align-self: center; padding: 0 2px 0 8px; white-space: nowrap }
                nav span:first-child { padding-left: 2px }
                button { flex: 1; font: inherit; font-size: 9px; color: var(--color-gray); border: none; border-radius: 2px;
                    background: hsl(from var(--color-display-stroke) h s l / 0.08); cursor: pointer; white-space: nowrap }
                button:hover { background: hsl(from var(--color-display-stroke) h s l / 0.16) }
                canvas { width: 100%; height: 100%; min-height: 0; display: block; border-radius: 4px; touch-action: none }
                .strip { grid-column: 1 / -1; cursor: pointer }
                .editor { cursor: crosshair }
                .hint { grid-column: 1 / -1; font-size: 9px; color: rgba(255, 255, 255, 0.3); white-space: nowrap;
                    overflow: hidden; text-overflow: ellipsis }
            </style>`
        const nav = document.createElement("nav")
        const stackCanvas = document.createElement("canvas")
        this.editor = document.createElement("canvas")
        this.editor.className = "editor"
        this.strip = document.createElement("canvas")
        this.strip.className = "strip"
        this.strip.title = "Pick the frame to edit"
        this.hint = document.createElement("div")
        this.hint.className = "hint"
        host.root.append(nav, stackCanvas, this.editor, this.strip, this.hint)
        this.group(nav, "Fill all frames")
        for (const [label, shape] of GENERATORS) {
            this.button(nav, label, `Replaces all ${FRAMES} frames with ${label}. Undo restores the table.`,
                () => this.write(buildTable(shape), `Filled all frames with ${label}.`))
        }
        this.group(nav, "Selected frame")
        this.button(nav, "Smooth", "Smooths the selected frame (the one in the right panel).", () => this.smoothFrame())
        this.group(nav, "Between first and last")
        this.button(nav, "Morph", `Rewrites frames 2 to ${FRAMES - 1} as a blend from frame 1 to frame ${FRAMES}. Draw the two ends first.`,
            () => this.morphEnds())
        this.showHint()
        this.stack = new Stack(host, stackCanvas)
        this.table = defaultTable()
        this.playing = 0
        this.selected = Math.round(host.params.position.value * (FRAMES - 1))
        this.load()
        host.data.table.subscribe(() => this.load())
        host.streams.frame.subscribe(values => {
            this.playing = Math.round(values[0])
            this.stack.setFrame(values[0])
            this.drawStrip()
        })
        new ResizeObserver(() => this.drawAll()).observe(host.root)
        this.editor.addEventListener("pointerdown", event => this.press(event))
        this.editor.addEventListener("pointermove", event => this.drag(event))
        this.editor.addEventListener("pointerup", () => this.release())
        this.strip.addEventListener("pointerdown", event => this.select(event))
        this.strip.addEventListener("pointermove", event => event.buttons === 1 && this.select(event))
    }
    group(parent, label) {
        const span = document.createElement("span")
        span.textContent = label
        parent.append(span)
    }
    button(parent, label, hint, action) {
        const button = document.createElement("button")
        button.textContent = label
        button.addEventListener("click", action)
        button.addEventListener("pointerenter", () => this.showHint(hint))
        button.addEventListener("pointerleave", () => this.showHint())
        parent.append(button)
    }
    showHint(text = `Draw in the right panel to edit frame ${this.selected + 1}. Pick another frame in the strip. Every change can be undone.`) {
        this.hint.textContent = text
    }
    load() {
        const stored = this.host.data.table.toArray()
        this.table = isEmpty(stored) ? defaultTable() : stored
        this.stack.selected = this.selected
        this.stack.setTable(this.table)
        this.drawEditor()
        this.drawStrip()
    }
    write(table, done) {
        this.host.edit(() => this.host.data.table.set(table))
        this.table = table
        this.load()
        this.showHint(done)
    }
    morphEnds() {
        const table = Float32Array.from(this.table)
        for (let frame = 1; frame < FRAMES - 1; frame++) {
            const t = frame / (FRAMES - 1)
            for (let index = 0; index < SIZE; index++) {
                table[frame * SIZE + index] = table[index] * (1 - t) + table[(FRAMES - 1) * SIZE + index] * t
            }
        }
        this.write(table, `Morphed frames 2 to ${FRAMES - 1} between frame 1 and frame ${FRAMES}.`)
    }
    smoothFrame() {
        const offset = this.selected * SIZE
        const smoothed = Array.from({length: SIZE}, (entry, index) =>
            (this.table[offset + (index + SIZE - 1) % SIZE] + 2 * this.table[offset + index] + this.table[offset + (index + 1) % SIZE]) / 4)
        this.host.edit(() => this.writeRange(smoothed, offset))
        this.showHint(`Smoothed frame ${this.selected + 1}.`)
    }
    // an empty stored table plays the default one, so the first partial edit stores the whole default first
    writeRange(values, offset) {
        if (isEmpty(this.host.data.table.toArray())) this.host.data.table.set(this.table)
        this.host.data.table.set(values, offset)
    }
    select(event) {
        this.selected = Math.max(0, Math.min(FRAMES - 1, Math.floor(event.offsetX / this.strip.clientWidth * FRAMES)))
        this.stack.selected = this.selected
        this.stack.draw()
        this.drawEditor()
        this.drawStrip()
        this.showHint()
    }
    point(event) {
        const index = Math.max(0, Math.min(SIZE - 1, Math.round(event.offsetX / this.editor.clientWidth * (SIZE - 1))))
        const value = Math.max(-1, Math.min(1, 1 - 2 * event.offsetY / this.editor.clientHeight))
        return {index, value}
    }
    press(event) {
        this.editor.setPointerCapture(event.pointerId)
        this.gesture = this.host.gesture()
        this.last = this.point(event)
        this.drag(event)
    }
    drag(event) {
        if (this.gesture === null) return
        const next = this.point(event)
        const from = Math.min(this.last.index, next.index), to = Math.max(this.last.index, next.index)
        const span = next.index - this.last.index
        const values = Array.from({length: to - from + 1}, (entry, offset) =>
            this.last.value + (next.value - this.last.value) * (span === 0 ? 1 : (from + offset - this.last.index) / span))
        values.forEach((value, offset) => this.table[this.selected * SIZE + from + offset] = value)
        this.gesture.edit(() => this.writeRange(values, this.selected * SIZE + from))
        this.last = next
        this.drawEditor()
    }
    release() {
        if (this.gesture === null) return
        this.gesture.end()
        this.gesture = null
    }
    prepare(canvas) {
        const ratio = devicePixelRatio
        canvas.width = canvas.clientWidth * ratio
        canvas.height = canvas.clientHeight * ratio
        const context = canvas.getContext("2d")
        context.scale(ratio, ratio)
        return {context, width: canvas.clientWidth, height: canvas.clientHeight}
    }
    drawAll() {
        this.stack.draw()
        this.drawEditor()
        this.drawStrip()
    }
    drawEditor() {
        const {context, width, height} = this.prepare(this.editor)
        context.strokeStyle = this.host.color("displayGrid", 0.12)
        context.beginPath()
        for (let line = 1; line < 4; line++) {
            context.moveTo(width * line / 4, 0)
            context.lineTo(width * line / 4, height)
        }
        context.stroke()
        context.strokeStyle = this.host.color("displayStroke", 0.25)
        context.setLineDash([2, 2])
        context.beginPath()
        context.moveTo(0, height / 2)
        context.lineTo(width, height / 2)
        context.stroke()
        context.setLineDash([])
        const path = new Path2D()
        for (let index = 0; index < SIZE; index++) {
            const x = index / (SIZE - 1) * width
            const y = (1 - this.table[this.selected * SIZE + index]) / 2 * height
            index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)
        }
        context.strokeStyle = this.host.color("displayStroke", 0.9)
        context.lineWidth = 1
        context.stroke(path)
        path.lineTo(width, height / 2)
        path.lineTo(0, height / 2)
        const gradient = context.createLinearGradient(0, 0, 0, height)
        gradient.addColorStop(0, this.host.color("displayStroke", 0.2))
        gradient.addColorStop(0.5, this.host.color("displayStroke", 0))
        gradient.addColorStop(1, this.host.color("displayStroke", 0.2))
        context.fillStyle = gradient
        context.fill(path)
        context.font = "9px Rubik"
        context.fillStyle = this.host.color("panelBackground", 0.8)
        context.fillRect(2, 2, 104, 14)
        context.fillStyle = "rgba(255, 255, 255, 0.3)"
        context.fillText(`Frame ${this.selected + 1}, draw to edit`, 6, 12)
    }
    drawStrip() {
        const {context, width, height} = this.prepare(this.strip)
        const cell = width / FRAMES
        for (let frame = 0; frame < FRAMES; frame++) {
            const opacity = frame === this.selected ? 0.6 : frame === this.playing ? 0.3 : 0.08
            context.fillStyle = this.host.color("displayStroke", opacity)
            context.fillRect(frame * cell + 0.5, 0, cell - 1, height)
        }
    }
}
