// @label XY Filter
// @param mix 1
// @param cutoff 1000 20 20000 exp Hz [omit-default-ui]
// @param resonance 0.707 0.1 10 exp [omit-default-ui]
// @view 2 1 4 3

const MIN_FREQUENCY = 20
const MAX_FREQUENCY = 20000
const MIN_Q = 0.1
const MAX_Q = 10
// the pad's vertical axis in dB: |H| at the cutoff equals Q, so the handle sits on the curve
const MAX_DB = 20
const MIN_DB = -20
const UPDATE_INTERVAL = 16
const SOURCE_COLORS = {automated: "blue", modulated: "green", midi: "orange", external: "purple"}

const unitOf = (value, min, max) => Math.log(value / min) / Math.log(max / min)
const valueOf = (unit, min, max) => min * Math.pow(max / min, Math.max(0, Math.min(1, unit)))

const lowpass = (coefficients, frequency, q, rate) => {
    const w0 = 2 * Math.PI * Math.min(frequency, rate * 0.49) / rate
    const alpha = Math.sin(w0) / (2 * q)
    const cos = Math.cos(w0)
    const a0 = 1 + alpha
    coefficients[0] = (1 - cos) / 2 / a0
    coefficients[1] = (1 - cos) / a0
    coefficients[2] = coefficients[0]
    coefficients[3] = -2 * cos / a0
    coefficients[4] = (1 - alpha) / a0
}

const magnitudeAt = (coefficients, frequency, rate) => {
    const w = 2 * Math.PI * frequency / rate
    const cos1 = Math.cos(w), sin1 = Math.sin(w), cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w)
    const [b0, b1, b2, a1, a2] = coefficients
    const numeratorRe = b0 + b1 * cos1 + b2 * cos2, numeratorIm = -(b1 * sin1 + b2 * sin2)
    const denominatorRe = 1 + a1 * cos1 + a2 * cos2, denominatorIm = -(a1 * sin1 + a2 * sin2)
    return Math.sqrt((numeratorRe ** 2 + numeratorIm ** 2) / (denominatorRe ** 2 + denominatorIm ** 2))
}

const formatFrequency = frequency => frequency >= 1000 ? `${(frequency / 1000).toFixed(2)} kHz` : `${Math.round(frequency)} Hz`

class Processor {
    coefficients = new Float64Array(5)
    states = new Float64Array(4)
    primed = false
    cutoff = 1000; resonance = 0.707; mix = 1
    cutoffTarget = 1000; resonanceTarget = 0.707; mixTarget = 1
    paramChanged(label, value) {
        if (label === "cutoff") this.cutoffTarget = value
        else if (label === "resonance") this.resonanceTarget = value
        else if (label === "mix") this.mixTarget = value
    }
    reset() {this.states.fill(0)}
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const c = this.coefficients, s = this.states
        if (!this.primed) {
            this.primed = true
            this.cutoff = this.cutoffTarget
            this.resonance = this.resonanceTarget
            this.mix = this.mixTarget
            lowpass(c, this.cutoff, this.resonance, sampleRate)
        }
        for (let i = s0; i < s1; i++) {
            // glide in the log domain every few samples: no zipper noise when automated or dragged
            if ((i - s0) % UPDATE_INTERVAL === 0) {
                this.cutoff *= Math.pow(this.cutoffTarget / this.cutoff, 0.05)
                this.resonance *= Math.pow(this.resonanceTarget / this.resonance, 0.05)
                lowpass(c, this.cutoff, this.resonance, sampleRate)
            }
            this.mix += (this.mixTarget - this.mix) * 0.002
            const left = srcL[i], right = srcR[i]
            const filteredL = c[0] * left + s[0]
            s[0] = c[1] * left - c[3] * filteredL + s[1]
            s[1] = c[2] * left - c[4] * filteredL
            const filteredR = c[0] * right + s[2]
            s[2] = c[1] * right - c[3] * filteredR + s[3]
            s[3] = c[2] * right - c[4] * filteredR
            outL[i] = left + (filteredL - left) * this.mix
            outR[i] = right + (filteredR - right) * this.mix
        }
    }
}

class View {
    gesture = null
    hovered = false
    constructor(host) {
        this.host = host
        this.coefficients = new Float64Array(5)
        host.root.style.cssText = `box-sizing: border-box; margin: 1px; width: calc(100% - 2px); height: calc(100% - 2px); padding: 4px; border: 0.5px solid ${host.color("displayGrid", 0.12)}; border-radius: 8px; display: grid; grid-template-columns: 8px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 8px; gap: 3px`
        this.pad = this.createCanvas(2, 1, "crosshair")
        this.resonanceScale = this.createCanvas(1, 1, "ns-resize")
        this.cutoffScale = this.createCanvas(2, 2, "ew-resize")
        // the scales carry the parameter menus, a right click on them opens automation, modulation and MIDI learn
        host.attachParameter(this.cutoffScale, "cutoff")
        host.attachParameter(this.resonanceScale, "resonance")
        for (const name of ["cutoff", "resonance"]) {
            host.params[name].subscribe(() => this.draw())
            host.params[name].subscribeSources(() => this.draw())
        }
        const observer = new ResizeObserver(() => this.draw())
        for (const canvas of [this.pad, this.cutoffScale, this.resonanceScale]) observer.observe(canvas)
        this.listen(this.pad, true, true)
        this.listen(this.cutoffScale, true, false)
        this.listen(this.resonanceScale, false, true)
        this.pad.addEventListener("pointerenter", () => {this.hovered = true; this.draw()})
        this.pad.addEventListener("pointerleave", () => {this.hovered = false; this.draw()})
    }
    createCanvas(column, row, cursor) {
        const canvas = document.createElement("canvas")
        canvas.style.cssText = `grid-column: ${column}; grid-row: ${row}; width: 100%; height: 100%; min-width: 0; min-height: 0; display: block; border-radius: 4px; touch-action: none; cursor: ${cursor}`
        this.host.root.append(canvas)
        return canvas
    }
    listen(canvas, horizontal, vertical) {
        const apply = event => this.gesture.edit(() => {
            if (horizontal) this.host.params.cutoff.set(valueOf(event.offsetX / canvas.clientWidth, MIN_FREQUENCY, MAX_FREQUENCY))
            if (vertical) this.host.params.resonance.set(valueOf(1 - event.offsetY / canvas.clientHeight, MIN_Q, MAX_Q))
        })
        const release = () => {
            if (this.gesture === null) return
            this.gesture.end()
            this.gesture = null
        }
        canvas.addEventListener("pointerdown", event => {
            if (event.button !== 0) return
            canvas.setPointerCapture(event.pointerId)
            this.gesture = this.host.gesture()
            apply(event)
        })
        canvas.addEventListener("pointermove", event => {if (this.gesture !== null) apply(event)})
        canvas.addEventListener("pointerup", release)
        canvas.addEventListener("lostpointercapture", release)
    }
    prepare(canvas) {
        const ratio = devicePixelRatio
        const width = canvas.clientWidth, height = canvas.clientHeight
        canvas.width = width * ratio
        canvas.height = height * ratio
        const context = canvas.getContext("2d")
        context.scale(ratio, ratio)
        context.lineWidth = 1
        return {context, width, height}
    }
    draw() {
        this.drawPad()
        this.drawScale(this.cutoffScale, this.host.params.cutoff, MIN_FREQUENCY, MAX_FREQUENCY, true)
        this.drawScale(this.resonanceScale, this.host.params.resonance, MIN_Q, MAX_Q, false)
    }
    drawPad() {
        const {context, width, height} = this.prepare(this.pad)
        const cutoff = this.host.params.cutoff.value, resonance = this.host.params.resonance.value
        const xOf = frequency => unitOf(frequency, MIN_FREQUENCY, MAX_FREQUENCY) * width
        const yOf = decibel => (MAX_DB - decibel) / (MAX_DB - MIN_DB) * height
        context.strokeStyle = this.host.color("displayGrid", 0.12)
        context.beginPath()
        for (const frequency of [100, 1000, 10000]) {
            const x = Math.round(xOf(frequency)) + 0.5
            context.moveTo(x, 0)
            context.lineTo(x, height)
        }
        context.stroke()
        context.strokeStyle = this.host.color("displayStroke", 0.25)
        context.setLineDash([2, 2])
        context.beginPath()
        const zero = Math.round(yOf(0)) + 0.5
        context.moveTo(0, zero)
        context.lineTo(width, zero)
        context.stroke()
        context.setLineDash([])
        lowpass(this.coefficients, cutoff, resonance, sampleRate)
        const curve = new Path2D()
        for (let x = 0; x <= width; x++) {
            const magnitude = magnitudeAt(this.coefficients, valueOf(x / width, MIN_FREQUENCY, MAX_FREQUENCY), sampleRate)
            const y = Math.min(height + 1, yOf(20 * Math.log10(magnitude + 1e-9)))
            x === 0 ? curve.moveTo(x, y) : curve.lineTo(x, y)
        }
        const area = new Path2D(curve)
        area.lineTo(width, height + 1)
        area.lineTo(0, height + 1)
        const gradient = context.createLinearGradient(0, 0, 0, height)
        gradient.addColorStop(0, this.host.color("displayStroke", 0.25))
        gradient.addColorStop(1, this.host.color("displayStroke", 0))
        context.fillStyle = gradient
        context.fill(area)
        context.strokeStyle = this.host.color("displayStroke", 0.9)
        context.stroke(curve)
        const handleX = xOf(cutoff), handleY = yOf(20 * Math.log10(resonance))
        context.beginPath()
        context.arc(handleX, handleY, 5, 0, Math.PI * 2)
        context.fillStyle = this.host.color("displayStroke", this.gesture !== null ? 0.5 : 0.2)
        context.fill()
        context.strokeStyle = this.host.color("displayStroke", 1)
        context.stroke()
        context.font = `9px ${getComputedStyle(this.pad).fontFamily}`
        context.fillStyle = "rgba(255, 255, 255, 0.2)"
        context.textAlign = "left"
        context.fillText(`${formatFrequency(cutoff)}  Q ${resonance.toFixed(2)}`, 4, 11)
        if (this.hovered) context.fillText("Right-click a scale for its menu", 4, height - 4)
    }
    drawScale(canvas, parameter, min, max, horizontal) {
        const {context, width, height} = this.prepare(canvas)
        const source = Object.keys(SOURCE_COLORS).find(key => parameter.sources.includes(key))
        const paint = source === undefined ? "displayStroke" : SOURCE_COLORS[source]
        const unit = unitOf(parameter.value, min, max)
        context.fillStyle = this.host.color(paint, 0.06)
        context.fillRect(0, 0, width, height)
        context.fillStyle = this.host.color(paint, 0.25)
        if (horizontal) {
            context.fillRect(0, 0, unit * width, height)
        } else {
            context.fillRect(0, (1 - unit) * height, width, unit * height)
        }
        context.fillStyle = this.host.color(paint, 0.9)
        if (horizontal) {
            context.fillRect(Math.round(unit * width) - 1, 0, 2, height)
        } else {
            context.fillRect(0, Math.round((1 - unit) * height) - 1, width, 2)
        }
    }
}
