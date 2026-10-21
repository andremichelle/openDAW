// @label Parametric EQ
// @param output 0 -24 24 linear dB
// @view 2 1 6 3
// @window 760 380
// @collection bands
// @field bands.type      2     0    4     int
// @field bands.frequency 1000  20   20000 exp  Hz
// @field bands.gain      0    -18   18    linear dB
// @field bands.q         0.71  0.1  10    exp
// @field bands.on        true
// @record bands type=0 frequency=30    q=0.71 on=0
// @record bands type=1 frequency=100   q=0.71
// @record bands type=2 frequency=500   q=1
// @record bands type=2 frequency=2500  q=1
// @record bands type=3 frequency=8000  q=0.71
// @record bands type=4 frequency=18000 q=0.71 on=0
// @stream spectrum 1024 fft

const LOW_CUT = 0
const LOW_SHELF = 1
const BELL = 2
const HIGH_SHELF = 3
const HIGH_CUT = 4
const TYPE_NAMES = ["Low Cut", "Low Shelf", "Bell", "High Shelf", "High Cut"]
const MIN_FREQUENCY = 20
const MAX_FREQUENCY = 20000
const MAX_GAIN = 18
const SPECTRUM_FLOOR = -84
// the @record seeds, for Reset
const DEFAULT_BANDS = [
    {type: LOW_CUT, frequency: 30, gain: 0, q: 0.71, on: 0},
    {type: LOW_SHELF, frequency: 100, gain: 0, q: 0.71, on: 1},
    {type: BELL, frequency: 500, gain: 0, q: 1, on: 1},
    {type: BELL, frequency: 2500, gain: 0, q: 1, on: 1},
    {type: HIGH_SHELF, frequency: 8000, gain: 0, q: 0.71, on: 1},
    {type: HIGH_CUT, frequency: 18000, gain: 0, q: 0.71, on: 0}
]
const WINDOW_BUTTON = -2
const RESET_BUTTON = -3
const SUB_BLOCK = 16
const SMOOTH_SECONDS = 0.02

// RBJ cookbook biquad, normalized: [b0, b1, b2, a1, a2] at target[offset]
function design(target, offset, type, frequency, gain, q, rate) {
    const w0 = 2 * Math.PI * Math.min(frequency, rate * 0.49) / rate
    const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * q), amp = Math.pow(10, gain / 40)
    let b0, b1, b2, a0, a1, a2
    if (type === LOW_CUT) {
        b0 = (1 + cos) / 2, b1 = -(1 + cos), b2 = b0, a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha
    } else if (type === HIGH_CUT) {
        b0 = (1 - cos) / 2, b1 = 1 - cos, b2 = b0, a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha
    } else if (type === BELL) {
        b0 = 1 + alpha * amp, b1 = -2 * cos, b2 = 1 - alpha * amp, a0 = 1 + alpha / amp, a1 = -2 * cos, a2 = 1 - alpha / amp
    } else {
        const root = 2 * Math.sqrt(amp) * alpha, sign = type === LOW_SHELF ? 1 : -1
        b0 = amp * ((amp + 1) - sign * (amp - 1) * cos + root)
        b1 = sign * 2 * amp * ((amp - 1) - sign * (amp + 1) * cos)
        b2 = amp * ((amp + 1) - sign * (amp - 1) * cos - root)
        a0 = (amp + 1) + sign * (amp - 1) * cos + root
        a1 = -sign * 2 * ((amp - 1) + sign * (amp + 1) * cos)
        a2 = (amp + 1) + sign * (amp - 1) * cos - root
    }
    target[offset] = b0 / a0
    target[offset + 1] = b1 / a0
    target[offset + 2] = b2 / a0
    target[offset + 3] = a1 / a0
    target[offset + 4] = a2 / a0
}

function magnitudeAt(coefficients, offset, frequency, rate) {
    const w = 2 * Math.PI * frequency / rate
    const cos1 = Math.cos(w), sin1 = Math.sin(w), cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w)
    const [b0, b1, b2, a1, a2] = [0, 1, 2, 3, 4].map(index => coefficients[offset + index])
    const numerator = Math.hypot(b0 + b1 * cos1 + b2 * cos2, b1 * sin1 + b2 * sin2)
    const denominator = Math.hypot(1 + a1 * cos1 + a2 * cos2, a1 * sin1 + a2 * sin2)
    return numerator / denominator
}

class Processor {
    gain = 1
    gainTarget = 1
    count = 0
    loaded = false
    constructor() {
        this.mono = new Float32Array(128)
        this.allocate(0)
    }
    allocate(count) {
        this.count = count
        this.types = new Int32Array(count)
        this.current = new Float64Array(count * 4)
        this.target = new Float64Array(count * 4)
        this.coefficients = new Float64Array(count * 5)
        this.states = new Float64Array(count * 4)
    }
    paramChanged(name, value) {
        if (name === "output") this.gainTarget = Math.pow(10, value / 20)
    }
    dataChanged(name) {
        if (name !== "bands") return
        const bands = this.data.bands
        if (bands.length !== this.count) {
            this.allocate(bands.length)
            this.loaded = false
        }
        bands.forEach((band, index) => {
            this.types[index] = band.type
            this.target.set([Math.log(band.frequency), band.gain, Math.log(band.q), band.on ? 1 : 0], index * 4)
        })
        if (!this.loaded) {
            this.current.set(this.target)
            this.loaded = true
        }
        for (let index = 0; index < this.count; index++) this.#design(index)
    }
    reset() {
        this.states.fill(0)
    }
    #design(index) {
        const {current} = this, base = index * 4
        design(this.coefficients, index * 5, this.types[index], Math.exp(current[base]), current[base + 1], Math.exp(current[base + 2]), sampleRate)
    }
    #smooth(samples) {
        const amount = 1 - Math.exp(-samples / (SMOOTH_SECONDS * sampleRate))
        for (let index = 0; index < this.count; index++) {
            let moved = false
            for (let field = index * 4; field < index * 4 + 4; field++) {
                const delta = this.target[field] - this.current[field]
                if (Math.abs(delta) < 1e-6) {
                    this.current[field] = this.target[field]
                    continue
                }
                this.current[field] += delta * amount
                moved = true
            }
            if (moved) this.#design(index)
            if (this.current[index * 4 + 3] === 0) this.states.fill(0, index * 4, index * 4 + 4)
        }
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const {coefficients, current, states} = this
        for (let start = s0; start < s1; start += SUB_BLOCK) {
            const end = Math.min(s1, start + SUB_BLOCK)
            this.#smooth(end - start)
            for (let i = start; i < end; i++) {
                let left = srcL[i], right = srcR[i]
                for (let band = 0; band < this.count; band++) {
                    const mix = current[band * 4 + 3]
                    if (mix === 0) continue
                    const c = band * 5, s = band * 4
                    const b0 = coefficients[c], b1 = coefficients[c + 1], b2 = coefficients[c + 2]
                    const a1 = coefficients[c + 3], a2 = coefficients[c + 4]
                    const filteredL = b0 * left + states[s]
                    states[s] = b1 * left - a1 * filteredL + states[s + 1]
                    states[s + 1] = b2 * left - a2 * filteredL
                    const filteredR = b0 * right + states[s + 2]
                    states[s + 2] = b1 * right - a1 * filteredR + states[s + 3]
                    states[s + 3] = b2 * right - a2 * filteredR
                    left += (filteredL - left) * mix
                    right += (filteredR - right) * mix
                }
                this.gain += (this.gainTarget - this.gain) * 0.002
                outL[i] = left * this.gain
                outR[i] = right * this.gain
            }
        }
        const spectrum = this.streams.spectrum
        if (!spectrum.active) return
        if (this.mono.length < s1) this.mono = new Float32Array(s1)
        for (let i = s0; i < s1; i++) this.mono[i] = (outL[i] + outR[i]) * 0.5
        spectrum.write(this.mono, s0, s1)
    }
}

class View {
    spectrum = new Float32Array(1024)
    selected = 2
    hovered = -1
    gesture = null
    wheelGesture = null
    wheelTimer = 0
    constructor(host) {
        this.host = host
        this.coefficients = new Float64Array(5)
        this.canvas = document.createElement("canvas")
        host.root.style.cssText = `box-sizing: border-box; padding: 4px; border: 0.5px solid ${host.color("displayGrid", 0.12)}; border-radius: 8px`
        this.canvas.style.cssText = "width: 100%; height: 100%; display: block; border-radius: 4px; touch-action: none"
        host.root.append(this.canvas)
        host.data.bands.subscribe(() => this.draw())
        host.streams.spectrum.subscribe(magnitudes => {
            for (let bin = 0; bin < magnitudes.length; bin++) {
                this.spectrum[bin] = Math.max(this.spectrum[bin] * 0.85, magnitudes[bin])
            }
            this.draw()
        })
        new ResizeObserver(() => this.draw()).observe(this.canvas)
        this.canvas.addEventListener("pointerdown", event => this.press(event))
        this.canvas.addEventListener("pointermove", event => this.move(event))
        this.canvas.addEventListener("pointerup", () => this.release())
        this.canvas.addEventListener("pointerleave", () => this.leave())
        this.canvas.addEventListener("dblclick", event => this.toggle(event))
        this.canvas.addEventListener("wheel", event => this.wheel(event), {passive: false})
    }
    get width() {return this.canvas.clientWidth}
    get height() {return this.canvas.clientHeight}
    xOf(frequency) {return Math.log(frequency / MIN_FREQUENCY) / Math.log(MAX_FREQUENCY / MIN_FREQUENCY) * this.width}
    frequencyOf(x) {return MIN_FREQUENCY * Math.pow(MAX_FREQUENCY / MIN_FREQUENCY, Math.max(0, Math.min(1, x / this.width)))}
    yOf(gain) {return (0.5 - gain / (MAX_GAIN * 2.5)) * this.height}
    gainOf(y) {return Math.max(-MAX_GAIN, Math.min(MAX_GAIN, (0.5 - y / this.height) * MAX_GAIN * 2.5))}
    hasGain(type) {return type !== LOW_CUT && type !== HIGH_CUT}
    handleOf(band) {return {x: this.xOf(band.frequency), y: this.yOf(this.hasGain(band.type) ? band.gain : 0)}}
    windowBounds() {return {x: this.width - 46, y: 2, width: 44, height: 14}}
    resetBounds() {return {x: this.width - (this.host.mode === "inline" ? 82 : 36), y: 2, width: 34, height: 14}}
    bandAt(event) {
        const bands = this.host.data.bands
        let best = -1, distance = 12 * 12
        for (let index = 0; index < bands.length; index++) {
            const {x, y} = this.handleOf(bands.get(index))
            const squared = (x - event.offsetX) ** 2 + (y - event.offsetY) ** 2
            if (squared < distance) {best = index, distance = squared}
        }
        return best
    }
    buttonAt(event) {
        const inside = ({x, y, width, height}) =>
            event.offsetX >= x && event.offsetX <= x + width && event.offsetY >= y && event.offsetY <= y + height
        if (this.host.mode === "inline" && inside(this.windowBounds())) return WINDOW_BUTTON
        if (inside(this.resetBounds())) return RESET_BUTTON
        return -1
    }
    reset() {
        const bands = this.host.data.bands
        this.host.edit(() => {
            DEFAULT_BANDS.forEach((band, index) => {if (index < bands.length) bands.set(index, band)})
            this.host.params.output.set(0)
        })
    }
    press(event) {
        const button = this.buttonAt(event)
        if (button === WINDOW_BUTTON) {
            this.host.openWindow()
            return
        }
        if (button === RESET_BUTTON) {
            this.reset()
            return
        }
        const index = this.bandAt(event)
        if (index === -1) return
        this.selected = index
        this.canvas.setPointerCapture(event.pointerId)
        this.gesture = this.host.gesture()
        this.draw()
    }
    move(event) {
        if (this.gesture === null) {
            const button = this.buttonAt(event)
            const hovered = button !== -1 ? button : this.bandAt(event)
            if (hovered !== this.hovered) {
                this.hovered = hovered
                this.canvas.style.cursor = button !== -1 ? "pointer" : hovered >= 0 ? "move" : "default"
                this.draw()
            }
            return
        }
        const band = this.host.data.bands.get(this.selected)
        const values = {frequency: this.frequencyOf(event.offsetX)}
        if (this.hasGain(band.type)) values.gain = this.gainOf(event.offsetY)
        this.gesture.edit(() => this.host.data.bands.set(this.selected, values))
    }
    release() {
        if (this.gesture === null) return
        this.gesture.end()
        this.gesture = null
    }
    leave() {
        if (this.gesture !== null || this.hovered === -1) return
        this.hovered = -1
        this.draw()
    }
    toggle(event) {
        const index = this.bandAt(event)
        if (index === -1) return
        this.host.data.bands.set(index, {on: this.host.data.bands.get(index).on ? 0 : 1})
    }
    wheel(event) {
        const index = this.bandAt(event)
        if (index === -1) return
        event.preventDefault()
        this.selected = index
        const q = Math.max(0.1, Math.min(10, this.host.data.bands.get(index).q * Math.pow(1.1, -Math.sign(event.deltaY))))
        if (this.wheelGesture === null) this.wheelGesture = this.host.gesture()
        this.wheelGesture.edit(() => this.host.data.bands.set(index, {q}))
        clearTimeout(this.wheelTimer)
        this.wheelTimer = setTimeout(() => {
            this.wheelGesture.end()
            this.wheelGesture = null
        }, 400)
    }
    responseAt(index, frequency) {
        const band = this.host.data.bands.get(index)
        if (!band.on) return 1
        design(this.coefficients, 0, band.type, band.frequency, band.gain, band.q, sampleRate)
        return magnitudeAt(this.coefficients, 0, frequency, sampleRate)
    }
    draw() {
        const ratio = devicePixelRatio
        const {width, height} = this
        this.canvas.width = width * ratio
        this.canvas.height = height * ratio
        const context = this.canvas.getContext("2d")
        context.scale(ratio, ratio)
        context.lineWidth = 1
        this.drawGrid(context)
        this.drawSpectrum(context)
        this.drawCurves(context)
        this.drawHandles(context)
        this.drawLabels(context)
    }
    drawGrid(context) {
        const {width, height} = this
        context.strokeStyle = this.host.color("displayGrid", 0.12)
        context.beginPath()
        for (const frequency of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
            const x = Math.round(this.xOf(frequency)) + 0.5
            context.moveTo(x, 0)
            context.lineTo(x, height)
        }
        for (const gain of [-12, -6, 6, 12]) {
            const y = Math.round(this.yOf(gain)) + 0.5
            context.moveTo(0, y)
            context.lineTo(width, y)
        }
        context.stroke()
        context.strokeStyle = this.host.color("displayStroke", 0.25)
        context.setLineDash([2, 2])
        context.beginPath()
        const zero = Math.round(this.yOf(0)) + 0.5
        context.moveTo(0, zero)
        context.lineTo(width, zero)
        context.stroke()
        context.setLineDash([])
    }
    drawSpectrum(context) {
        const {width, height} = this
        const binWidth = sampleRate / (this.spectrum.length * 2)
        const path = new Path2D()
        path.moveTo(0, height)
        for (let x = 0; x <= width; x++) {
            const low = this.frequencyOf(x) / binWidth, high = this.frequencyOf(x + 1) / binWidth
            let peak = 0
            for (let bin = Math.floor(low); bin <= Math.max(Math.floor(low), Math.floor(high)) && bin < this.spectrum.length; bin++) {
                peak = Math.max(peak, this.spectrum[bin])
            }
            const decibel = 20 * Math.log10(peak + 1e-9)
            path.lineTo(x, height * Math.min(1, decibel / SPECTRUM_FLOOR))
        }
        path.lineTo(width, height)
        const gradient = context.createLinearGradient(0, 0, 0, height)
        gradient.addColorStop(0, this.host.color("displayStroke", 0.12))
        gradient.addColorStop(1, this.host.color("displayStroke", 0))
        context.fillStyle = gradient
        context.fill(path)
    }
    drawCurves(context) {
        const {width} = this
        const bands = this.host.data.bands
        const total = new Path2D(), selected = new Path2D()
        const focus = this.hovered >= 0 ? this.hovered : this.selected
        for (let x = 0; x <= width; x++) {
            const frequency = this.frequencyOf(x)
            let magnitude = 1
            for (let index = 0; index < bands.length; index++) magnitude *= this.responseAt(index, frequency)
            const y = this.yOf(20 * Math.log10(magnitude))
            x === 0 ? total.moveTo(x, y) : total.lineTo(x, y)
            const single = this.yOf(20 * Math.log10(this.responseAt(focus, frequency)))
            x === 0 ? selected.moveTo(x, single) : selected.lineTo(x, single)
        }
        context.strokeStyle = this.host.color("displayStroke", 0.4)
        context.stroke(selected)
        selected.lineTo(width, this.yOf(0))
        selected.lineTo(0, this.yOf(0))
        context.fillStyle = this.host.color("displayStroke", 0.06)
        context.fill(selected)
        context.strokeStyle = this.host.color("displayStroke", 0.9)
        context.stroke(total)
    }
    drawHandles(context) {
        const bands = this.host.data.bands
        context.font = `8px ${getComputedStyle(this.canvas).fontFamily}`
        context.textAlign = "center"
        for (let index = 0; index < bands.length; index++) {
            const band = bands.get(index)
            const {x, y} = this.handleOf(band)
            const focused = index === this.selected || index === this.hovered
            context.beginPath()
            context.arc(x, y, 5, 0, Math.PI * 2)
            const paint = band.on ? "displayStroke" : "yellow"
            context.fillStyle = this.host.color(paint, focused ? 0.5 : 0.2)
            context.fill()
            context.strokeStyle = this.host.color(paint, focused ? 1 : 0.6)
            context.stroke()
            context.fillStyle = band.on ? "rgba(255, 255, 255, 0.6)" : this.host.color("yellow", 0.9)
            context.fillText(String(index + 1), x, y + 3)
        }
    }
    drawLabels(context) {
        const {width, height} = this
        const font = getComputedStyle(this.canvas).fontFamily
        context.font = `8px ${font}`
        context.fillStyle = "rgba(255, 255, 255, 0.2)"
        context.textAlign = "center"
        for (const [frequency, label] of [[100, "100"], [1000, "1k"], [10000, "10k"]]) {
            context.fillText(label, this.xOf(frequency), height - 3)
        }
        context.font = `9px ${font}`
        context.textAlign = "left"
        const focus = this.hovered >= 0 ? this.hovered : this.selected
        if (focus < this.host.data.bands.length) {
            const band = this.host.data.bands.get(focus)
            const frequency = band.frequency >= 1000 ? `${(band.frequency / 1000).toFixed(2)} kHz` : `${Math.round(band.frequency)} Hz`
            const gain = this.hasGain(band.type) ? ` ${band.gain >= 0 ? "+" : ""}${band.gain.toFixed(1)} dB` : ""
            context.fillText(`${focus + 1} ${TYPE_NAMES[band.type]} ${frequency}${gain} Q ${band.q.toFixed(2)}${band.on ? "" : " (off)"}`, 4, 11)
        }
        if (this.hovered >= 0) {
            context.fillText("Drag: frequency and gain. Wheel: Q. Double-click: on or off.", 4, height - 14)
        } else if (this.hovered === RESET_BUTTON) {
            context.fillText("Reset: every band and the output back to the defaults.", 4, height - 14)
        }
        context.textAlign = "right"
        const label = (bounds, text, button) => {
            context.fillStyle = `rgba(255, 255, 255, ${this.hovered === button ? 0.6 : 0.2})`
            context.fillText(text, bounds.x + bounds.width - 2, bounds.y + 10)
        }
        label(this.resetBounds(), "Reset", RESET_BUTTON)
        if (this.host.mode === "inline") label(this.windowBounds(), "Window", WINDOW_BUTTON)
    }
}
