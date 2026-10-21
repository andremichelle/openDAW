// @label Step Arp
// @no-pass
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
                    pitch: Math.max(0, Math.min(127, source.pitch + Math.floor(order / this.held.length) * 12 + step.transpose)),
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
    gesture = null
    current = -1
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
        const width = this.canvas.clientWidth, height = this.canvas.clientHeight - 12
        const steps = this.host.data.steps
        const index = Math.max(0, Math.min(steps.length - 1, Math.floor(event.offsetX / width * steps.length)))
        const velocity = 1 - Math.max(0, Math.min(1, event.offsetY / height))
        return {index, velocity, toggle: event.offsetY > height}
    }
    press(event) {
        const {index, velocity, toggle} = this.locate(event)
        const steps = this.host.data.steps
        if (toggle) {
            steps.set(index, {on: steps.get(index).on ? 0 : 1})
            this.draw()
            return
        }
        this.canvas.setPointerCapture(event.pointerId)
        this.gesture = this.host.gesture()
        this.gesture.edit(() => steps.set(index, {velocity}))
        this.draw()
    }
    drag(event) {
        if (this.gesture === null) return
        const {index, velocity} = this.locate(event)
        this.gesture.edit(() => this.host.data.steps.set(index, {velocity}))
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
        const steps = this.host.data.steps
        const cell = width / steps.length
        const barHeight = height - 12
        for (let index = 0; index < steps.length; index++) {
            const step = steps.get(index)
            const x = index * cell
            context.fillStyle = index === this.current ? this.host.color("cream") : this.host.color("shadow")
            context.fillRect(x + 1, 0, cell - 2, barHeight)
            context.fillStyle = step.on ? this.host.color("blue") : this.host.color("gray")
            context.fillRect(x + 1, barHeight * (1 - step.velocity), cell - 2, barHeight * step.velocity)
            context.fillStyle = step.on ? this.host.color("orange") : this.host.color("dark")
            context.fillRect(x + 1, barHeight + 3, cell - 2, 8)
        }
    }
}
