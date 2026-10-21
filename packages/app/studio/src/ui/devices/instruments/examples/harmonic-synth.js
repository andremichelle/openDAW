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
            context.fillStyle = pressed ? this.host.color("blue") : this.host.color(black ? "black" : "cream")
            context.fillRect(key * cell + 0.5, 0, cell - 1, height)
        }
    }
}
