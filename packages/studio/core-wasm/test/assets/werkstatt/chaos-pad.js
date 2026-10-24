// @label Chaos Pad
// @param mix 1
// @param program 0 0 4 int [omit-default-ui]
// @param x 0.5 [omit-default-ui]
// @param y 0.5 [omit-default-ui]
// @param touch false [omit-default-ui]
// @param hold false [omit-default-ui]
// @view 2 1 6 3

const PROGRAMS = ["Filter", "Delay", "Flanger", "Repeat", "Decimator"]
const AXES = [["cutoff", "resonance"], ["time", "feedback"], ["rate", "depth"], ["slice", "pitch"], ["rate", "bits"]]
const FILTER = 0, DELAY = 1, FLANGER = 2, REPEAT = 3, DECIMATOR = 4
const DELAY_BEATS = [0.25, 0.5, 0.75, 1, 1.5, 2]
const REPEAT_BEATS = [1, 0.5, 0.25, 0.125]
const PARAMETER_SMOOTHING = 0.002
const ENGAGE_SMOOTHING = 0.003
const COEFFICIENT_INTERVAL = 16
const CENTER = 0.5
const FADE = 64
const TRAIL_MS = 600
const DOT_SPACING = 6
const GLOW_RADIUS = 9
const SOURCE_COLORS = {automated: "blue", modulated: "green", midi: "orange", external: "purple"}

const pickStep = (steps, unit) => steps[Math.max(0, Math.min(steps.length - 1, Math.floor(unit * steps.length)))]
const clampUnit = value => Math.max(0, Math.min(1, value))
const powerOfTwoAbove = value => 1 << Math.ceil(Math.log2(value))

class Processor {
    constructor() {
        this.size = powerOfTwoAbove(sampleRate * 4)
        this.mask = this.size - 1
        this.flangeMask = powerOfTwoAbove(sampleRate * 0.01) - 1
        this.historyL = new Float32Array(this.size); this.historyR = new Float32Array(this.size)
        this.lineL = new Float32Array(this.size); this.lineR = new Float32Array(this.size)
        this.flangeL = new Float32Array(this.flangeMask + 1); this.flangeR = new Float32Array(this.flangeMask + 1)
        this.svfState = new Float64Array(4)
        this.write = 0
        this.program = FILTER
        this.x = 0.5; this.y = 0.5; this.mix = 1
        this.xTarget = 0.5; this.yTarget = 0.5; this.mixTarget = 1
        this.touchTarget = false; this.holdTarget = false; this.touched = false; this.engage = 0
        this.k = 1; this.a1 = 1; this.a2 = 0; this.a3 = 0; this.lowpass = true
        this.delayTime = sampleRate * 0.5
        this.phase = 0
        this.repeatStart = 0; this.repeatPosition = 0; this.repeatElapsed = 0
        this.holdPhase = 0; this.heldL = 0; this.heldR = 0
        this.wetL = 0; this.wetR = 0
    }
    paramChanged(label, value) {
        if (label === "x") this.xTarget = value
        else if (label === "y") this.yTarget = value
        else if (label === "mix") this.mixTarget = value
        else if (label === "touch") this.touchTarget = value >= 0.5
        else if (label === "hold") this.holdTarget = value >= 0.5
        else if (label === "program" && Math.round(value) !== this.program) {
            this.program = Math.round(value)
            this.trigger()
        }
    }
    reset() {
        for (const buffer of [this.historyL, this.historyR, this.lineL, this.lineR, this.flangeL, this.flangeR, this.svfState]) buffer.fill(0)
        this.engage = 0
        this.touched = false
    }
    trigger() {
        this.repeatStart = this.write
        this.repeatPosition = 0
        this.repeatElapsed = 0
    }
    process({src, out}, {s0, s1, bpm}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const tempo = bpm > 0 ? bpm : 120
        const engaged = this.touchTarget || this.holdTarget
        if (engaged && !this.touched) this.trigger()
        this.touched = engaged
        const maxSlice = Math.min(this.size >> 1, Math.round(REPEAT_BEATS[0] * 60 / tempo * sampleRate))
        for (let i = s0; i < s1; i++) {
            this.x += (this.xTarget - this.x) * PARAMETER_SMOOTHING
            this.y += (this.yTarget - this.y) * PARAMETER_SMOOTHING
            this.mix += (this.mixTarget - this.mix) * PARAMETER_SMOOTHING
            this.engage += ((engaged ? 1 : 0) - this.engage) * ENGAGE_SMOOTHING
            const inL = srcL[i], inR = srcR[i]
            // a repeat freezes its history once the longest slice is captured
            if (this.program !== REPEAT || !this.touched || this.repeatElapsed < maxSlice) {
                this.historyL[this.write] = inL
                this.historyR[this.write] = inR
            }
            switch (this.program) {
                case FILTER: this.filter(inL, inR, i - s0); break
                case DELAY: this.delay(inL, inR, tempo); break
                case FLANGER: this.flanger(inL, inR); break
                case REPEAT: this.repeat(tempo); break
                default: this.decimator(inL, inR)
            }
            if (this.program === DELAY) {
                outL[i] = inL + this.wetL * this.mix
                outR[i] = inR + this.wetR * this.mix
            } else {
                const amount = this.engage * this.mix
                outL[i] = inL + (this.wetL - inL) * amount
                outR[i] = inR + (this.wetR - inR) * amount
            }
            this.write = (this.write + 1) & this.mask
        }
    }
    read(line, mask, delay) {
        const position = this.write - delay
        const index = Math.floor(position)
        const fraction = position - index
        const a = line[index & mask], b = line[(index + 1) & mask]
        return a + (b - a) * fraction
    }
    filter(inL, inR, counter) {
        if (counter % COEFFICIENT_INTERVAL === 0) {
            this.lowpass = this.x < 0.5
            const frequency = this.lowpass ? 80 * Math.pow(250, this.x * 2) : 20 * Math.pow(400, this.x * 2 - 1)
            const g = Math.tan(Math.PI * Math.min(frequency, sampleRate * 0.45) / sampleRate)
            this.k = 1 / (0.5 * Math.pow(16, this.y))
            this.a1 = 1 / (1 + g * (g + this.k))
            this.a2 = g * this.a1
            this.a3 = g * this.a2
        }
        this.wetL = this.svf(0, inL)
        this.wetR = this.svf(2, inR)
    }
    svf(offset, input) {
        const state = this.svfState
        const v3 = input - state[offset + 1]
        const v1 = this.a1 * state[offset] + this.a2 * v3
        const v2 = state[offset + 1] + this.a2 * state[offset] + this.a3 * v3
        state[offset] = 2 * v1 - state[offset]
        state[offset + 1] = 2 * v2 - state[offset + 1]
        return this.lowpass ? v2 : input - this.k * v1 - v2
    }
    delay(inL, inR, tempo) {
        const target = Math.max(2, Math.min(this.size - 4, pickStep(DELAY_BEATS, this.x) * 60 / tempo * sampleRate))
        this.delayTime += (target - this.delayTime) * 0.0005
        const feedback = this.y * 0.95
        const delayedL = this.read(this.lineL, this.mask, this.delayTime)
        const delayedR = this.read(this.lineR, this.mask, this.delayTime)
        this.lineL[this.write] = inL * this.engage + delayedR * feedback
        this.lineR[this.write] = inR * this.engage + delayedL * feedback
        this.wetL = delayedL
        this.wetR = delayedR
    }
    flanger(inL, inR) {
        this.phase = (this.phase + 0.05 * Math.pow(100, this.x) / sampleRate) % 1
        const base = 0.0003 * sampleRate, sweep = 0.004 * sampleRate * (0.2 + this.y * 0.8)
        const feedback = this.y * 0.8
        const delayL = base + sweep * (0.5 + 0.5 * Math.sin(2 * Math.PI * this.phase))
        const delayR = base + sweep * (0.5 + 0.5 * Math.sin(2 * Math.PI * (this.phase + 0.25)))
        const delayedL = this.read(this.flangeL, this.flangeMask, delayL)
        const delayedR = this.read(this.flangeR, this.flangeMask, delayR)
        this.flangeL[this.write & this.flangeMask] = inL + Math.tanh(delayedL * feedback)
        this.flangeR[this.write & this.flangeMask] = inR + Math.tanh(delayedR * feedback)
        this.wetL = (inL + delayedL) * 0.5
        this.wetR = (inR + delayedR) * 0.5
    }
    repeat(tempo) {
        const length = Math.max(FADE * 2, Math.min(this.size >> 1, Math.round(pickStep(REPEAT_BEATS, this.x) * 60 / tempo * sampleRate)))
        const position = this.repeatPosition % length
        const gain = Math.min(1, position / FADE, (length - position) / FADE)
        const absolute = this.repeatStart + position
        const index = Math.floor(absolute), fraction = absolute - index
        const aL = this.historyL[index & this.mask], bL = this.historyL[(index + 1) & this.mask]
        const aR = this.historyR[index & this.mask], bR = this.historyR[(index + 1) & this.mask]
        this.wetL = (aL + (bL - aL) * fraction) * gain
        this.wetR = (aR + (bR - aR) * fraction) * gain
        this.repeatPosition += Math.pow(2, -this.y)
        this.repeatElapsed++
    }
    decimator(inL, inR) {
        this.holdPhase += 1 / Math.pow(64, this.x)
        if (this.holdPhase >= 1) {
            this.holdPhase -= Math.floor(this.holdPhase)
            this.heldL = inL
            this.heldR = inR
        }
        const steps = Math.pow(2, 15 - this.y * 14)
        this.wetL = Math.round(this.heldL * steps) / steps
        this.wetR = Math.round(this.heldR * steps) / steps
    }
}

class View {
    trail = []
    gesture = null
    hovered = false
    frame = 0
    constructor(host) {
        this.host = host
        host.root.style.cssText = `box-sizing: border-box; margin: 1px; width: calc(100% - 2px); height: calc(100% - 2px); padding: 4px; border: 0.5px solid ${host.color("displayGrid", 0.12)}; border-radius: 8px; display: grid; grid-template-columns: 6px minmax(0, 1fr) 56px; grid-template-rows: minmax(0, 1fr) 6px; gap: 3px`
        const style = document.createElement("style")
        style.textContent = `.button { font-size: 9px; line-height: 13px; padding: 0 4px; border-radius: 3px; cursor: pointer; user-select: none; color: rgba(255, 255, 255, 0.3) }
.button:hover { color: rgba(255, 255, 255, 0.6) }
.button.active { color: ${host.color("displayStroke")}; background: ${host.color("displayStroke", 0.1)} }`
        host.root.append(style)
        this.pad = this.createCanvas(2, 1, "crosshair")
        this.yScale = this.createCanvas(1, 1, "ns-resize")
        this.xScale = this.createCanvas(2, 2, "ew-resize")
        const list = document.createElement("div")
        list.style.cssText = "grid-column: 3; grid-row: 1 / span 2; display: flex; flex-direction: column; gap: 1px; min-height: 0"
        host.root.append(list)
        this.programButtons = PROGRAMS.map((name, index) => this.createButton(list, name, "program", () => host.params.program.set(index)))
        this.holdButton = this.createButton(list, "Hold", "hold", () => this.toggleHold())
        this.holdButton.style.marginTop = "auto"
        host.attachParameter(this.pad, "touch")
        host.attachParameter(this.xScale, "x")
        host.attachParameter(this.yScale, "y")
        for (const name of ["x", "y", "touch"]) {
            host.params[name].subscribe(() => this.moved())
            host.params[name].subscribeSources(() => this.draw())
        }
        host.params.program.subscribe(() => this.updateButtons())
        host.params.hold.subscribe(() => this.updateButtons())
        new ResizeObserver(() => this.draw()).observe(this.pad)
        this.listenPad()
        this.listenScale(this.xScale, "x", event => event.offsetX / this.xScale.clientWidth)
        this.listenScale(this.yScale, "y", event => 1 - event.offsetY / this.yScale.clientHeight)
        this.pad.addEventListener("pointerenter", () => {this.hovered = true; this.draw()})
        this.pad.addEventListener("pointerleave", () => {this.hovered = false; this.draw()})
        this.updateButtons()
    }
    get touched() {return this.host.params.touch.value >= 0.5 || this.host.params.hold.value >= 0.5}
    createCanvas(column, row, cursor) {
        const canvas = document.createElement("canvas")
        canvas.style.cssText = `grid-column: ${column}; grid-row: ${row}; width: 100%; height: 100%; min-width: 0; min-height: 0; display: block; border-radius: 4px; touch-action: none; cursor: ${cursor}`
        this.host.root.append(canvas)
        return canvas
    }
    createButton(list, label, parameter, onClick) {
        const button = document.createElement("div")
        button.className = "button"
        button.textContent = label
        button.addEventListener("click", onClick)
        this.host.attachParameter(button, parameter)
        list.append(button)
        return button
    }
    updateButtons() {
        const program = Math.round(this.host.params.program.value)
        this.programButtons.forEach((button, index) => button.classList.toggle("active", index === program))
        this.holdButton.classList.toggle("active", this.host.params.hold.value >= 0.5)
        this.draw()
    }
    toggleHold() {
        const {hold} = this.host.params
        this.host.edit(() => {
            const on = hold.value < 0.5
            hold.set(on ? 1 : 0)
            if (!on && this.gesture === null) this.letGo()
        })
    }
    letGo() {
        const {x, y, touch} = this.host.params
        touch.set(0)
        x.set(CENTER)
        y.set(CENTER)
    }
    listenPad() {
        const {x, y, touch, hold} = this.host.params
        const place = event => {
            x.set(clampUnit(event.offsetX / this.pad.clientWidth))
            y.set(clampUnit(1 - event.offsetY / this.pad.clientHeight))
        }
        const release = () => {
            if (this.gesture === null) return
            if (hold.value < 0.5) this.gesture.edit(() => this.letGo())
            this.gesture.end()
            this.gesture = null
        }
        this.pad.addEventListener("pointerdown", event => {
            if (event.button !== 0) return
            this.pad.setPointerCapture(event.pointerId)
            this.gesture = this.host.gesture()
            this.gesture.edit(() => {
                place(event)
                touch.set(1)
            })
        })
        this.pad.addEventListener("pointermove", event => {if (this.gesture !== null) this.gesture.edit(() => place(event))})
        this.pad.addEventListener("pointerup", release)
        this.pad.addEventListener("lostpointercapture", release)
    }
    listenScale(canvas, name, unitOf) {
        const state = {gesture: null}
        const apply = event => state.gesture.edit(() => this.host.params[name].set(clampUnit(unitOf(event))))
        const release = () => {
            if (state.gesture === null) return
            state.gesture.end()
            state.gesture = null
        }
        canvas.addEventListener("pointerdown", event => {
            if (event.button !== 0) return
            canvas.setPointerCapture(event.pointerId)
            state.gesture = this.host.gesture()
            apply(event)
        })
        canvas.addEventListener("pointermove", event => {if (state.gesture !== null) apply(event)})
        canvas.addEventListener("pointerup", release)
        canvas.addEventListener("lostpointercapture", release)
    }
    moved() {
        if (this.touched) {
            this.trail.push({x: this.host.params.x.value, y: this.host.params.y.value, time: performance.now()})
            if (this.trail.length > 48) this.trail.shift()
        }
        this.draw()
    }
    draw() {
        if (this.frame !== 0) return
        this.frame = requestAnimationFrame(now => {
            this.frame = 0
            this.trail = this.trail.filter(point => now - point.time < TRAIL_MS)
            this.drawPad(now)
            this.drawScale(this.xScale, this.host.params.x, true)
            this.drawScale(this.yScale, this.host.params.y, false)
            if (this.trail.length > 0) this.draw()
        })
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
    paintOf(parameter) {
        const source = Object.keys(SOURCE_COLORS).find(key => parameter.sources.includes(key))
        return source === undefined ? "displayStroke" : SOURCE_COLORS[source]
    }
    drawPad(now) {
        const {context, width, height} = this.prepare(this.pad)
        const {x, y, touch, program} = this.host.params
        const touched = this.touched
        const columns = Math.floor(width / DOT_SPACING), rows = Math.floor(height / DOT_SPACING)
        const offsetX = (width - (columns - 1) * DOT_SPACING) / 2, offsetY = (height - (rows - 1) * DOT_SPACING) / 2
        const points = this.trail.map(point => ({x: point.x * width, y: (1 - point.y) * height, life: 1 - (now - point.time) / TRAIL_MS}))
        if (touched) points.push({x: x.value * width, y: (1 - y.value) * height, life: 1})
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                const dotX = offsetX + column * DOT_SPACING, dotY = offsetY + row * DOT_SPACING
                let light = 0
                for (const point of points) {
                    const distance = (dotX - point.x) ** 2 + (dotY - point.y) ** 2
                    light = Math.max(light, point.life * Math.exp(-distance / (GLOW_RADIUS * GLOW_RADIUS)))
                }
                context.fillStyle = this.host.color("displayStroke", 0.08 + 0.92 * light)
                context.beginPath()
                context.arc(dotX, dotY, 1.2, 0, Math.PI * 2)
                context.fill()
            }
        }
        const handleX = (touched ? x.value : CENTER) * width, handleY = (1 - (touched ? y.value : CENTER)) * height
        context.strokeStyle = this.host.color("displayStroke", touched ? 0.9 : 0.3)
        context.beginPath()
        context.arc(handleX, handleY, 6, 0, Math.PI * 2)
        context.stroke()
        if (touch.sources.length > 0) {
            context.fillStyle = this.host.color(this.paintOf(touch), 0.9)
            context.beginPath()
            context.arc(width - 4, 4, 2, 0, Math.PI * 2)
            context.fill()
        }
        context.font = `9px ${getComputedStyle(this.pad).fontFamily}`
        context.fillStyle = "rgba(255, 255, 255, 0.2)"
        context.textAlign = "left"
        if (this.hovered) {
            const [horizontal, vertical] = AXES[Math.round(program.value)] ?? AXES[0]
            context.fillText(`X ${horizontal}  Y ${vertical}`, 4, height - 4)
        }
    }
    drawScale(canvas, parameter, horizontal) {
        const {context, width, height} = this.prepare(canvas)
        const paint = this.paintOf(parameter)
        const unit = parameter.value
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
