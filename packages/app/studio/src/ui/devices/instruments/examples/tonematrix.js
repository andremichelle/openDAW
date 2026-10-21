// Tonematrix for openDAW Apparat
// A port of github.com/andremichelle/tonematrix: 16x16 steps, sine voices, 3/16 echo, ripple glow.
//
// @group Voice blue
// @param release   0.25  0.02  2.0   exp     s
// @param direct    1     0     1     linear
// @group Echo green
// @param echo      0.1   0     0.25  linear
// @param feedback  0.4   0     0.9   linear
//
// @buffer pattern 256
// @stream step 1 value
// @view View 2 1 4 3
// @window View 600 520

const SIZE = 16
const STEP_PPQN = 240          // a semiquaver at 960 ppqn per quarter
const VOICE_GAIN = 0.75
// the dry level of the original at a full direct knob
const DIRECT_GAIN = 0.25
const MAX_VOICES = 128
// top row is the highest note, as in the original (MIDI 96 down to 60)
const NOTES = [96, 93, 91, 89, 86, 84, 81, 79, 77, 74, 72, 69, 67, 65, 62, 60]

// deterministic stand in for Math.random() - Math.random() in the original panner
function hash01(n) {
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d)
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b)
    n ^= n >>> 16
    return (n >>> 0) / 4294967296
}

class Processor {
    constructor() {
        this.cells = new Uint8Array(SIZE * SIZE)
        this.freq = new Float32Array(SIZE)
        for (let y = 0; y < SIZE; y++) this.freq[y] = 440 * Math.pow(2, (NOTES[y] - 69) / 12)
        // voice pool, kept compact (active voices are 0..count-1)
        this.vPhase = new Float64Array(MAX_VOICES)
        this.vInc = new Float64Array(MAX_VOICES)
        this.vGain = new Float32Array(MAX_VOICES)
        this.vDecay = new Float32Array(MAX_VOICES)
        this.vL = new Float32Array(MAX_VOICES)
        this.vR = new Float32Array(MAX_VOICES)
        this.vId = new Int32Array(MAX_VOICES)
        this.count = 0
        // stereo echo
        this.delayLength = Math.ceil(sampleRate * 3) + 4
        this.delayL = new Float32Array(this.delayLength)
        this.delayR = new Float32Array(this.delayLength)
        this.writeIndex = 0
        this.delaySamples = 0.375 * sampleRate
        this.delayTarget = this.delaySamples
        // params (target and smoothed)
        this.release = 0.25
        this.direct = 1
        this.echo = 0.1
        this.feedback = 0.4
        this.sDirect = 1
        this.sEcho = 0.1
        this.sFeedback = 0.4
        this.smooth = 1 - Math.exp(-1 / (0.005 * sampleRate))
        this.glide = 1 - Math.exp(-1 / (0.05 * sampleRate))
    }

    paramChanged(name, value) {
        if (name === "release") this.release = Math.max(0.001, value)
        else if (name === "direct") this.direct = value
        else if (name === "echo") this.echo = value
        else if (name === "feedback") this.feedback = Math.min(0.95, Math.max(0, value))
    }

    dataChanged(name) {
        if (name !== "pattern") return
        const data = this.data.pattern
        for (let i = 0; i < SIZE * SIZE; i++) this.cells[i] = data !== undefined && data[i] > 0.5 ? 1 : 0
    }

    startVoice(freq, gain, pan, id) {
        let index = this.count
        if (index >= MAX_VOICES) {
            // steal the quietest
            index = 0
            for (let i = 1; i < MAX_VOICES; i++) if (this.vGain[i] < this.vGain[index]) index = i
        } else {
            this.count++
        }
        const p = (pan + 1) * 0.25 * Math.PI // equal power, like StereoPannerNode on a mono source
        this.vPhase[index] = 0
        this.vInc[index] = freq / sampleRate
        this.vGain[index] = gain
        this.vDecay[index] = gain / (this.release * sampleRate) // linear ramp to zero
        this.vL[index] = Math.cos(p)
        this.vR[index] = Math.sin(p)
        this.vId[index] = id
    }

    removeVoice(i) {
        const last = --this.count
        this.vPhase[i] = this.vPhase[last]
        this.vInc[i] = this.vInc[last]
        this.vGain[i] = this.vGain[last]
        this.vDecay[i] = this.vDecay[last]
        this.vL[i] = this.vL[last]
        this.vR[i] = this.vR[last]
        this.vId[i] = this.vId[last]
    }

    // incoming notes play the same voice, so the device also works from a piano roll
    noteOn(pitch, velocity, cent, id) {
        this.startVoice(440 * Math.pow(2, (pitch - 69 + cent / 100) / 12), VOICE_GAIN * velocity, 0, id)
    }

    noteOff(id) {
        // voices are one shots (attack free, linear release), as in the original
    }

    reset() {
        const fade = 0.005 * sampleRate
        for (let i = 0; i < this.count; i++) this.vDecay[i] = Math.max(this.vDecay[i], this.vGain[i] / fade)
        if (this.streams !== undefined && this.streams.step !== undefined) this.streams.step[0] = -1
    }

    triggerStep(k) {
        const x = ((k % SIZE) + SIZE) % SIZE
        for (let y = 0; y < SIZE; y++) {
            if (this.cells[y * SIZE + x] === 1) {
                const seed = (k * SIZE + y) | 0
                const pan = hash01(seed * 2) - hash01(seed * 2 + 1)
                this.startVoice(this.freq[y], VOICE_GAIN, pan, -1)
            }
        }
        if (this.streams !== undefined && this.streams.step !== undefined) this.streams.step[0] = x
    }

    render(outL, outR, from, to) {
        const delayL = this.delayL
        const delayR = this.delayR
        const length = this.delayLength
        const twoPi = Math.PI * 2
        for (let s = from; s < to; s++) {
            let busL = 0
            let busR = 0
            for (let i = this.count - 1; i >= 0; i--) {
                const g = this.vGain[i]
                const v = Math.sin(this.vPhase[i] * twoPi) * g
                busL += v * this.vL[i]
                busR += v * this.vR[i]
                let phase = this.vPhase[i] + this.vInc[i]
                if (phase >= 1) phase -= 1
                this.vPhase[i] = phase
                const next = g - this.vDecay[i]
                if (next <= 0) this.removeVoice(i)
                else this.vGain[i] = next
            }
            // smoothing
            this.sDirect += (this.direct - this.sDirect) * this.smooth
            this.sEcho += (this.echo - this.sEcho) * this.smooth
            this.sFeedback += (this.feedback - this.sFeedback) * this.smooth
            this.delaySamples += (this.delayTarget - this.delaySamples) * this.glide
            // delay read (linear interpolation)
            let read = this.writeIndex - this.delaySamples
            if (read < 0) read += length
            const i0 = read | 0
            const frac = read - i0
            const i1 = i0 + 1 === length ? 0 : i0 + 1
            const dL = delayL[i0] + (delayL[i1] - delayL[i0]) * frac
            const dR = delayR[i0] + (delayR[i1] - delayR[i0]) * frac
            // WebAudio graph: bus -> delay -> feedback gain -> (delay, wet gain -> out)
            const fbL = dL * this.sFeedback
            const fbR = dR * this.sFeedback
            delayL[this.writeIndex] = busL + fbL
            delayR[this.writeIndex] = busR + fbR
            if (++this.writeIndex === length) this.writeIndex = 0
            outL[s] += fbL * this.sEcho + busL * this.sDirect * DIRECT_GAIN
            outR[s] += fbR * this.sEcho + busR * this.sDirect * DIRECT_GAIN
        }
    }

    process(output, block) {
        const outL = output[0]
        const outR = output[1]
        const bpm = block.bpm > 1 ? block.bpm : 120
        // 3/16 of a bar
        this.delayTarget = Math.min(this.delayLength - 2, (45 / bpm) * sampleRate)
        let cursor = block.s0
        const playing = (block.flags & 4) !== 0
        if (playing && block.p1 > block.p0 && block.s1 > block.s0) {
            const ppqnToSamples = (block.s1 - block.s0) / (block.p1 - block.p0)
            for (let k = Math.ceil(block.p0 / STEP_PPQN); k * STEP_PPQN < block.p1; k++) {
                let at = block.s0 + Math.round((k * STEP_PPQN - block.p0) * ppqnToSamples)
                if (at < cursor) at = cursor
                if (at > block.s1 - 1) at = block.s1 - 1
                if (at > cursor) {
                    this.render(outL, outR, cursor, at)
                    cursor = at
                }
                this.triggerStep(k)
            }
        } else if (!playing && this.streams !== undefined && this.streams.step !== undefined) {
            this.streams.step[0] = -1
        }
        if (cursor < block.s1) this.render(outL, outR, cursor, block.s1)
    }
}

function clearPattern(host) {
    const values = host.data.pattern.toArray()
    let any = false
    for (let i = 0; i < values.length; i++) if (values[i] > 0.5) any = true
    if (!any) return false
    host.edit(() => host.data.pattern.set(new Array(SIZE * SIZE).fill(0), 0))
    return true
}

function makeButton(host, parent, text, title, action) {
    const element = document.createElement("button")
    element.textContent = text
    element.title = title
    const idle = host.color("white", 0.55)
    element.style.cssText = "font:inherit;background:none;border:none;padding:0;cursor:pointer;color:" + idle + ";"
    element.addEventListener("pointerenter", () => element.style.color = host.color("white", 0.9))
    element.addEventListener("pointerleave", () => element.style.color = idle)
    element.addEventListener("click", action)
    parent.appendChild(element)
    return element
}

// inline and window: the square grid at full height on the left, buttons in the free space to its right
class View {
    constructor(host) {
        const windowed = host.mode === "window"
        const root = host.root
        root.style.cssText = "display:flex;gap:" + (windowed ? 8 : 4) + "px;padding:0;box-sizing:border-box;" +
            "width:100%;height:100%;min-width:0;min-height:0;"
        new Matrix(host, root)
        const side = document.createElement("div")
        side.style.cssText = "flex:1 1 0;display:flex;flex-direction:column;align-items:flex-start;gap:6px;" +
            "min-width:0;padding:2px 0;overflow:hidden;font-size:" + (windowed ? 11 : 9) + "px;"
        root.appendChild(side)
        const hint = document.createElement("span")
        const idle = windowed ? "Click or drag to toggle steps" : ""
        makeButton(host, side, "Clear", "Clear all 256 steps (undoable)", () => {
            hint.textContent = clearPattern(host) ? "Cleared, undo restores it" : "Already empty"
        })
        if (!windowed) makeButton(host, side, "Open", "Open the large matrix in a window", () => host.openWindow())
        hint.style.cssText = "margin-top:auto;font-size:" + (windowed ? 9 : 8) + "px;line-height:1.3;" +
            "color:rgba(255,255,255,0.2);overflow-wrap:anywhere;"
        hint.textContent = idle
        side.appendChild(hint)
    }
}

// the 16x16 matrix: a square canvas that fills the height of its parent
class Matrix {
    constructor(host, parent) {
        this.host = host
        this.cells = new Uint8Array(SIZE * SIZE)
        this.waves = [new Float32Array(SIZE * SIZE), new Float32Array(SIZE * SIZE)]
        this.waveIndex = 0
        this.step = -1
        this.running = false
        this.stroke = host.color("white")
        this.colors = {
            offOuter: host.color("white", 0.06),
            offInner: host.color("white", 0.03),
            onOuter: host.color("white", 0.95),
            onInner: host.color("white", 0.78),
            column: host.color("white", 0.06)
        }
        this.canvas = document.createElement("canvas")
        this.canvas.style.cssText = "flex:none;display:block;touch-action:none;cursor:crosshair;"
        parent.appendChild(this.canvas)
        // the square follows the parent's height (never the canvas itself, so no layout feedback)
        new ResizeObserver(() => {
            const size = Math.max(0, Math.floor(Math.min(parent.clientHeight, parent.clientWidth)))
            this.canvas.style.width = size + "px"
            this.canvas.style.height = size + "px"
        }).observe(parent)
        this.context = this.canvas.getContext("2d")
        this.glow = document.createElement("canvas")
        this.glow.width = this.glow.height = SIZE
        this.glowContext = this.glow.getContext("2d")

        this.readPattern()
        host.data.pattern.subscribe(() => {
            this.readPattern()
            this.draw()
        })
        host.streams.step.subscribe(values => {
            const value = values !== undefined && values.length !== undefined ? values[0] : values
            const step = value >= 0 ? Math.round(value) & (SIZE - 1) : -1
            if (step === this.step) return
            this.step = step
            if (step >= 0) {
                for (let y = 0; y < SIZE; y++) if (this.cells[y * SIZE + step] === 1) this.touch(step, y)
            }
            this.draw()
        })
        this.installPointer()
        new ResizeObserver(() => {
            const dpr = devicePixelRatio || 1
            this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
            this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
            this.context.setTransform(dpr, 0, 0, dpr, 0, 0)
            this.draw()
        }).observe(this.canvas)
    }

    readPattern() {
        const values = this.host.data.pattern.toArray()
        for (let i = 0; i < SIZE * SIZE; i++) this.cells[i] = values[i] > 0.5 ? 1 : 0
    }

    layout() {
        const width = this.canvas.clientWidth
        const height = this.canvas.clientHeight
        const size = Math.min(width, height)
        return {x: 0, y: 0, size, cell: size / SIZE}
    }

    cellAt(event) {
        const rect = this.canvas.getBoundingClientRect()
        const {x, y, cell} = this.layout()
        const cx = Math.floor((event.clientX - rect.left - x) / cell)
        const cy = Math.floor((event.clientY - rect.top - y) / cell)
        return cx < 0 || cx >= SIZE || cy < 0 || cy >= SIZE ? -1 : cy * SIZE + cx
    }

    installPointer() {
        let gesture = null
        let drawValue = 0
        const apply = index => {
            if (index < 0 || this.cells[index] === drawValue) return
            this.cells[index] = drawValue
            gesture.edit(() => this.host.data.pattern.set([drawValue], index))
            if (drawValue === 1) this.touch(index % SIZE, (index / SIZE) | 0)
            this.draw()
        }
        this.canvas.addEventListener("pointerdown", event => {
            const index = this.cellAt(event)
            if (index < 0) return
            event.preventDefault()
            this.canvas.setPointerCapture(event.pointerId)
            drawValue = this.cells[index] === 1 ? 0 : 1
            gesture = this.host.gesture()
            apply(index)
        })
        this.canvas.addEventListener("pointermove", event => {
            if (gesture !== null) apply(this.cellAt(event))
        })
        const end = () => {
            if (gesture === null) return
            gesture.end()
            gesture = null
        }
        this.canvas.addEventListener("pointerup", end)
        this.canvas.addEventListener("pointercancel", end)
    }

    touch(x, y) {
        this.waves[0][y * SIZE + x] = -1
        this.waves[1][y * SIZE + x] = -1
        if (!this.running) {
            this.running = true
            requestAnimationFrame(() => this.frame())
        }
    }

    // the ripple simulation of the original, one step per animation frame
    simulate() {
        const a = this.waves[this.waveIndex]
        const b = this.waves[1 - this.waveIndex]
        let energy = 0
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const i = y * SIZE + x
                let amp = 0
                if (x > 0) amp += a[i - 1]
                if (y > 0) amp += a[i - SIZE]
                if (x < SIZE - 1) amp += a[i + 1]
                if (y < SIZE - 1) amp += a[i + SIZE]
                amp = (amp * 0.25 - b[i]) * 0.86
                if (amp < -1) amp = -1
                else if (amp > 1) amp = 1
                b[i] = amp
                energy += Math.abs(amp)
            }
        }
        this.waveIndex = 1 - this.waveIndex
        return energy
    }

    frame() {
        const energy = this.simulate()
        this.draw()
        if (energy > 0.001) {
            requestAnimationFrame(() => this.frame())
        } else {
            this.waves[0].fill(0)
            this.waves[1].fill(0)
            this.running = false
            this.draw()
        }
    }

    fillRound(x, y, size, radius) {
        const context = this.context
        if (radius <= 0 || context.roundRect === undefined) {
            context.fillRect(x, y, size, size)
            return
        }
        context.beginPath()
        context.roundRect(x, y, size, size, radius)
        context.fill()
    }

    draw() {
        const context = this.context
        const width = this.canvas.clientWidth
        const height = this.canvas.clientHeight
        if (width === 0 || height === 0) return
        context.clearRect(0, 0, width, height)
        const {x: ox, y: oy, size, cell} = this.layout()
        const colors = this.colors
        if (this.step >= 0) {
            context.fillStyle = colors.column
            context.fillRect(ox + this.step * cell, oy, cell, size)
        }
        const outer = cell >= 12 ? cell * 2 / 32 : 0.5
        const inner = cell >= 12 ? cell * 4 / 32 : (cell >= 6 ? 1 : 0.5)
        const radius = Math.min(2, cell * 0.1)
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const on = this.cells[y * SIZE + x] === 1
                const px = ox + x * cell
                const py = oy + y * cell
                context.fillStyle = on ? colors.onOuter : colors.offOuter
                this.fillRound(px + outer, py + outer, cell - outer * 2, radius)
                if (inner < cell / 2) {
                    context.fillStyle = on ? colors.onInner : colors.offInner
                    this.fillRound(px + inner, py + inner, cell - inner * 2, Math.max(0, radius - (inner - outer)))
                }
            }
        }
        if (!this.running) return
        // glow: positive wave amplitudes, scaled up smoothly, blurred and added
        const glow = this.glowContext
        const wave = this.waves[this.waveIndex]
        glow.clearRect(0, 0, SIZE, SIZE)
        glow.fillStyle = this.stroke
        for (let i = 0; i < SIZE * SIZE; i++) {
            const amp = wave[i]
            if (amp <= 0.003) continue
            glow.globalAlpha = Math.min(1, Math.pow(amp, 0.75))
            glow.fillRect(i % SIZE, (i / SIZE) | 0, 1, 1)
        }
        glow.globalAlpha = 1
        context.save()
        context.globalCompositeOperation = "lighter"
        context.imageSmoothingEnabled = true
        context.filter = "blur(" + (cell * 0.25).toFixed(2) + "px)"
        context.drawImage(this.glow, ox, oy, size, size)
        context.restore()
    }
}
