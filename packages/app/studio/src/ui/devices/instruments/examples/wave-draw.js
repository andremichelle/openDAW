// @label Wave Draw
// @param attack  0.005 0.001 1   exp  s
// @param release 0.2   0.01  2   exp  s
// @view 2 1 6 3
// @buffer wave 256

const SIZE = 256

class Processor {
    voices = []
    attack = 0.005
    release = 0.2
    wave = Float32Array.from({length: SIZE}, (entry, index) => Math.sin(2 * Math.PI * index / SIZE))
    paramChanged(label, value) {
        this[label] = value
    }
    dataChanged(name) {
        if (name !== "wave") return
        const drawn = this.data.wave
        if (drawn.some(value => value !== 0)) this.wave = drawn
    }
    message(data) {
        if (data.type === "retrigger") for (const voice of this.voices) voice.phase = 0
    }
    noteOn(pitch, velocity, cent, id) {
        const frequency = 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)
        this.voices.push({id, velocity, gate: true, level: 0, phase: 0, step: frequency * SIZE / sampleRate})
    }
    noteOff(id) {
        for (const voice of this.voices) if (voice.id === id) voice.gate = false
    }
    reset() {
        for (const voice of this.voices) voice.gate = false
    }
    process(output, block) {
        const [outL, outR] = output
        const wave = this.wave
        const rise = 1 / (this.attack * sampleRate)
        const fall = Math.exp(-1 / (this.release * sampleRate))
        for (const voice of this.voices) {
            for (let s = block.s0; s < block.s1; s++) {
                voice.level = voice.gate ? Math.min(1, voice.level + rise) : voice.level * fall
                const position = voice.phase | 0
                const fraction = voice.phase - position
                const value = wave[position] + (wave[(position + 1) % SIZE] - wave[position]) * fraction
                const sample = value * voice.level * voice.velocity * 0.25
                outL[s] += sample
                outR[s] += sample
                voice.phase = (voice.phase + voice.step) % SIZE
            }
        }
        this.voices = this.voices.filter(voice => voice.gate || voice.level > 0.0001)
    }
}

class View {
    gesture = null
    last = null
    constructor(host) {
        this.host = host
        host.root.innerHTML = `
            <style>
                body { margin: 0; box-sizing: border-box; padding: 4px; border: 0.5px solid hsl(from var(--color-display-grid) h s l / 0.12); border-radius: 8px; display: grid; grid-template-rows: minmax(0, 1fr) 16px; gap: 4px; height: 100vh }
                canvas { width: 100%; height: 100%; min-height: 0; display: block; border-radius: 4px; touch-action: none; cursor: crosshair }
                div { display: flex; gap: 4px }
                button { flex: 1; font: inherit; font-size: 9px; color: var(--color-gray); border: none; border-radius: 2px;
                    background: hsl(from var(--color-display-stroke) h s l / 0.08); cursor: pointer }
                button:hover { background: hsl(from var(--color-display-stroke) h s l / 0.16) }
            </style>`
        this.canvas = document.createElement("canvas")
        const buttons = document.createElement("div")
        host.root.append(this.canvas, buttons)
        for (const [label, action] of [["Sine", () => this.fill(index => Math.sin(2 * Math.PI * index / SIZE))],
            ["Saw", () => this.fill(index => 1 - 2 * index / SIZE)], ["Retrigger", () => host.send({type: "retrigger"})]]) {
            const button = document.createElement("button")
            button.textContent = label
            button.addEventListener("click", action)
            buttons.append(button)
        }
        host.data.wave.subscribe(() => this.draw())
        new ResizeObserver(() => this.draw()).observe(this.canvas)
        this.canvas.addEventListener("pointerdown", event => this.press(event))
        this.canvas.addEventListener("pointermove", event => this.drag(event))
        this.canvas.addEventListener("pointerup", () => this.release())
    }
    fill(shape) {
        this.host.data.wave.set(Array.from({length: SIZE}, (entry, index) => shape(index)))
        this.draw()
    }
    point(event) {
        const index = Math.max(0, Math.min(SIZE - 1, Math.round(event.offsetX / this.canvas.clientWidth * (SIZE - 1))))
        const value = Math.max(-1, Math.min(1, 1 - 2 * event.offsetY / this.canvas.clientHeight))
        return {index, value}
    }
    press(event) {
        this.canvas.setPointerCapture(event.pointerId)
        this.gesture = this.host.gesture()
        this.last = this.point(event)
        this.drag(event)
    }
    drag(event) {
        if (this.gesture === null) return
        const next = this.point(event)
        const from = Math.min(this.last.index, next.index), to = Math.max(this.last.index, next.index)
        const values = Array.from({length: to - from + 1}, (entry, offset) => {
            const span = next.index - this.last.index
            const ratio = span === 0 ? 1 : (from + offset - this.last.index) / span
            return this.last.value + (next.value - this.last.value) * ratio
        })
        this.gesture.edit(() => this.host.data.wave.set(values, from))
        this.last = next
        this.draw()
    }
    release() {
        if (this.gesture === null) return
        this.gesture.end()
        this.gesture = null
    }
    draw() {
        const ratio = devicePixelRatio
        const width = this.canvas.clientWidth, height = this.canvas.clientHeight
        this.canvas.width = width * ratio
        this.canvas.height = height * ratio
        const context = this.canvas.getContext("2d")
        context.scale(ratio, ratio)
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
            const y = (1 - this.host.data.wave.get(index)) / 2 * height
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
    }
}
