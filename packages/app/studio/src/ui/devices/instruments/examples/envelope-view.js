// @label Envelope Synth
// @param attack  0.01  0.001 2   exp  s
// @param decay   0.2   0.001 2   exp  s
// @param sustain 0.6   0     1   linear
// @param release 0.4   0.001 4   exp  s
// @view 3 1 6 3

const STAGES = ["attack", "decay", "release"]

class Processor {
    voices = []
    attack = 0.01
    decay = 0.2
    sustain = 0.6
    release = 0.4
    paramChanged(label, value) {
        this[label] = value
    }
    noteOn(pitch, velocity, cent, id) {
        const frequency = 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)
        this.voices.push({id, velocity, phase: 0, step: frequency / sampleRate, level: 0, stage: 0})
    }
    noteOff(id) {
        for (const voice of this.voices) if (voice.id === id) voice.stage = 3
    }
    reset() {
        for (const voice of this.voices) voice.stage = 3
    }
    process(output, block) {
        const [outL, outR] = output
        const attackRate = 1 / (this.attack * sampleRate)
        const decayRate = 1 / (this.decay * sampleRate)
        const releaseRate = 1 / (this.release * sampleRate)
        for (const voice of this.voices) {
            for (let s = block.s0; s < block.s1; s++) {
                if (voice.stage === 0) {
                    voice.level += attackRate
                    if (voice.level >= 1) {
                        voice.level = 1
                        voice.stage = 1
                    }
                } else if (voice.stage === 1) {
                    voice.level = Math.max(this.sustain, voice.level - decayRate)
                } else if (voice.stage === 3) {
                    voice.level = Math.max(0, voice.level - releaseRate)
                }
                const sample = (voice.phase * 2 - 1) * voice.level * voice.velocity * 0.2
                outL[s] += sample
                outR[s] += sample
                voice.phase = (voice.phase + voice.step) % 1
            }
        }
        this.voices = this.voices.filter(voice => voice.stage !== 3 || voice.level > 0)
    }
}

class View {
    gesture = null
    constructor(host) {
        this.host = host
        this.canvas = document.createElement("canvas")
        this.canvas.style.cssText = "width: 100%; height: 100%; display: block; touch-action: none; cursor: ew-resize"
        host.root.append(this.canvas)
        for (const name of ["attack", "decay", "sustain", "release"]) host.params[name].subscribe(() => this.draw())
        new ResizeObserver(() => this.draw()).observe(this.canvas)
        this.canvas.addEventListener("pointerdown", event => this.press(event))
        this.canvas.addEventListener("pointermove", event => this.drag(event))
        this.canvas.addEventListener("pointerup", () => this.release())
    }
    layout() {
        const {attack, decay, release} = this.host.params
        const total = attack.value + decay.value + release.value + 0.5
        const width = this.canvas.clientWidth
        const scale = width / total
        return {scale, attackX: attack.value * scale, decayX: (attack.value + decay.value) * scale,
            releaseX: width - release.value * scale}
    }
    press(event) {
        const {attackX, decayX, releaseX} = this.layout()
        const x = event.offsetX
        const distances = [attackX, decayX, releaseX].map(position => Math.abs(position - x))
        this.stage = STAGES[distances.indexOf(Math.min(...distances))]
        this.startX = x
        this.startValue = this.host.params[this.stage].value
        this.canvas.setPointerCapture(event.pointerId)
        this.gesture = this.host.gesture()
    }
    drag(event) {
        if (this.gesture === null) return
        const {scale} = this.layout()
        const direction = this.stage === "release" ? -1 : 1
        const value = Math.max(0.001, this.startValue + direction * (event.offsetX - this.startX) / scale)
        this.gesture.edit(() => this.host.params[this.stage].set(value))
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
        const {attackX, decayX, releaseX} = this.layout()
        const top = 4, bottom = height - 4
        const sustainY = bottom - (bottom - top) * this.host.params.sustain.value
        context.strokeStyle = this.host.color("orange")
        context.lineWidth = 1.5
        context.beginPath()
        context.moveTo(0, bottom)
        context.lineTo(attackX, top)
        context.lineTo(decayX, sustainY)
        context.lineTo(releaseX, sustainY)
        context.lineTo(width, bottom)
        context.stroke()
        context.fillStyle = this.host.color("cream")
        for (const [x, y] of [[attackX, top], [decayX, sustainY], [releaseX, sustainY]]) {
            context.fillRect(x - 2, y - 2, 4, 4)
        }
    }
}
