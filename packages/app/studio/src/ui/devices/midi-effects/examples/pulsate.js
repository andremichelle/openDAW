// @label Pulsate
// @param growth   0.125 0.02 1    exp
// @param length   192   10   960  int
// @param velocity 0.7
// @view 2 1 6 3
// @collection circles
// @field circles.x 0.5
// @field circles.y 0.5
// @stream state 129

const MAX_CIRCLES = 64
const BAR = 3840
const WIDTH = 2
const HEIGHT = 1
// the field height of the original toy in pixels, its note mapping is in pixels
const PIXELS = 800
// a ring centred in the field is never visible again beyond the field diagonal
const RETIRE_RADIUS = 2.5
const CONTACT = 1e-9
const MAX_EVENTS = 100000
const PENTATONIC = [0, 2, 5, 7, 9]
const ACTIVE = 1
const RETIRED = 2

class Solver {
    constructor() {
        this.time = 0
        this.speed = 0
        this.size = 0
        this.x = new Float64Array(MAX_CIRCLES)
        this.y = new Float64Array(MAX_CIRCLES)
        this.radius = new Float64Array(MAX_CIRCLES)
        this.since = new Float64Array(MAX_CIRCLES)
        this.velocity = new Float64Array(MAX_CIRCLES)
        this.state = new Uint8Array(MAX_CIRCLES)
        this.selfTime = new Float64Array(MAX_CIRCLES)
        this.pairTime = new Float64Array(MAX_CIRCLES * MAX_CIRCLES)
        this.distances = new Float64Array(MAX_CIRCLES * MAX_CIRCLES)
        this.bestTime = new Float64Array(MAX_CIRCLES)
        this.bestPartner = new Int32Array(MAX_CIRCLES)
    }
    // circles that kept their position keep their ring, every other one starts at radius zero
    sync(records) {
        const previous = {
            size: this.size, x: this.x.slice(), y: this.y.slice(), velocity: this.velocity.slice(), state: this.state.slice(),
            radius: Float64Array.from(this.x, (entry, index) => this.radiusAt(index, this.time))
        }
        const claimed = new Uint8Array(MAX_CIRCLES)
        this.size = Math.min(MAX_CIRCLES, records.length)
        for (let index = 0; index < this.size; index++) {
            const x = records[index].x * WIDTH, y = records[index].y * HEIGHT
            let match = -1
            for (let other = 0; other < previous.size && match === -1; other++) {
                if (claimed[other] === 0 && previous.x[other] === x && previous.y[other] === y) {match = other}
            }
            this.x[index] = x
            this.y[index] = y
            if (match === -1) {
                this.state[index] = ACTIVE
                this.rebase(index, 0, this.speed)
            } else {
                claimed[match] = 1
                this.state[index] = previous.state[match]
                this.rebase(index, previous.radius[match], previous.velocity[match])
            }
        }
        for (let index = 0; index < this.size; index++) {
            for (let other = 0; other < this.size; other++) {
                this.distances[index * MAX_CIRCLES + other] = Math.hypot(this.x[other] - this.x[index], this.y[other] - this.y[index])
            }
        }
        this.refreshAll()
    }
    setSpeed(speed) {
        this.speed = speed
        for (let index = 0; index < this.size; index++) {
            const velocity = this.velocity[index]
            this.rebase(index, this.radiusAt(index, this.time), velocity < 0 ? -speed : speed)
        }
        this.refreshAll()
    }
    refreshAll() {
        this.pairTime.fill(Infinity)
        this.bestTime.fill(Infinity)
        this.bestPartner.fill(-1)
        for (let index = 0; index < this.size; index++) {
            if (this.state[index] === ACTIVE) {this.refresh(index)} else {this.selfTime[index] = Infinity}
        }
    }
    radiusAt(index, time) {return this.radius[index] + this.velocity[index] * (time - this.since[index])}
    isActive(index) {return this.state[index] === ACTIVE}
    advance(target, observer) {
        const {size} = this
        for (let events = 0; events < MAX_EVENTS; events++) {
            let next = target, kind = 0, first = -1, second = -1
            for (let index = 0; index < size; index++) {
                if (this.state[index] !== ACTIVE || this.bestTime[index] >= next) {continue}
                next = this.bestTime[index]
                first = index
                second = this.bestPartner[index]
                kind = second === -1 ? 2 : 3
            }
            if (kind === 0) {break}
            this.time = Math.max(this.time, next)
            if (kind === 2) {
                if (this.velocity[first] < 0) {
                    this.rebase(first, 0, -this.velocity[first])
                    this.refresh(first)
                } else {
                    this.retire(first)
                }
            } else {
                this.collide(first, second)
                if (observer !== null) {observer(this.time, first, second)}
            }
        }
        this.time = Math.max(this.time, target)
    }
    rebase(index, radius, velocity) {
        this.radius[index] = radius
        this.since[index] = this.time
        this.velocity[index] = velocity
    }
    retire(index) {
        const {size} = this
        this.state[index] = RETIRED
        this.selfTime[index] = Infinity
        this.bestTime[index] = Infinity
        for (let other = 0; other < size; other++) {
            this.pairTime[index * MAX_CIRCLES + other] = Infinity
            this.pairTime[other * MAX_CIRCLES + index] = Infinity
            if (this.state[other] === ACTIVE && this.bestPartner[other] === index) {this.rescan(other)}
        }
    }
    collide(first, second) {
        const {time} = this
        const radiusA = this.radiusAt(first, time), radiusB = this.radiusAt(second, time)
        const velocityA = this.velocity[first], velocityB = this.velocity[second]
        if (this.isExternal(first, second, radiusA, radiusB)) {
            this.rebase(first, radiusA, -velocityB)
            this.rebase(second, radiusB, -velocityA)
        } else {
            this.rebase(first, radiusA, velocityB)
            this.rebase(second, radiusB, velocityA)
        }
        this.refresh(first)
        this.refresh(second)
    }
    distance(first, second) {return this.distances[first * MAX_CIRCLES + second]}
    isExternal(first, second, radiusA, radiusB) {return radiusA + radiusB <= this.distance(first, second) + CONTACT}
    refresh(index) {
        const {size, time} = this
        const radius = this.radiusAt(index, time), velocity = this.velocity[index]
        this.selfTime[index] = velocity < 0
            ? time + radius / -velocity
            : velocity > 0 ? time + Math.max(0, RETIRE_RADIUS - radius) / velocity : Infinity
        for (let other = 0; other < size; other++) {
            if (other === index || this.state[other] !== ACTIVE) {continue}
            const contact = this.contact(index, other)
            this.pairTime[index * MAX_CIRCLES + other] = contact
            this.pairTime[other * MAX_CIRCLES + index] = contact
            if (contact < this.bestTime[other]) {
                this.bestTime[other] = contact
                this.bestPartner[other] = index
            } else if (this.bestPartner[other] === index) {
                this.rescan(other)
            }
        }
        this.rescan(index)
    }
    rescan(index) {
        const {size} = this
        let best = this.selfTime[index], partner = -1
        for (let other = 0; other < size; other++) {
            const time = this.pairTime[index * MAX_CIRCLES + other]
            if (time < best) {best = time, partner = other}
        }
        this.bestTime[index] = best
        this.bestPartner[index] = partner
    }
    // the rings never cross: outside each other the gap closes with the sum of the velocities, nested with their difference
    contact(first, second) {
        const {time} = this
        const radiusA = this.radiusAt(first, time), radiusB = this.radiusAt(second, time)
        const velocityA = this.velocity[first], velocityB = this.velocity[second]
        const distance = this.distance(first, second)
        let gap, closing
        if (this.isExternal(first, second, radiusA, radiusB)) {
            gap = distance - radiusA - radiusB
            closing = velocityA + velocityB
        } else if (radiusA >= radiusB) {
            gap = radiusA - radiusB - distance
            closing = velocityB - velocityA
        } else {
            gap = radiusB - radiusA - distance
            closing = velocityA - velocityB
        }
        return closing > 0 ? time + Math.max(0, gap) / closing : Infinity
    }
}

// the original radiusToNote: pentatonic, small rings play high
function radiusToPitch(radius) {
    const pixels = Math.max(1, Math.min(160, radius * PIXELS))
    const index = Math.floor(36 - 36 * (pixels - 1) / 159)
    return Math.max(4, Math.floor(index / 5)) * 12 + PENTATONIC[index % 5]
}

class Processor {
    length = 192
    velocity = 0.7
    hits = []
    constructor() {
        this.solver = new Solver()
        this.solver.setSpeed(0.125 / BAR)
        this.offset = 0
        this.collect = (time, first, second) => this.hits.push(time + this.offset,
            this.solver.radiusAt(first, time), this.solver.radiusAt(second, time))
    }
    paramChanged(name, value) {
        if (name === "growth") this.solver.setSpeed(value / BAR)
        if (name === "length") this.length = Math.max(1, value)
        if (name === "velocity") this.velocity = value
    }
    dataChanged(name) {
        if (name === "circles") this.solver.sync(this.data.circles)
    }
    * process(block, events) {
        const {solver} = this
        const span = block.to - block.from
        if (span > 0) {
            this.offset = block.from - solver.time
            this.hits.length = 0
            solver.advance(solver.time + span, this.collect)
            for (let index = 0; index < this.hits.length; index += 3) {
                const position = Math.max(block.from, this.hits[index])
                for (const radius of [this.hits[index + 1], this.hits[index + 2]]) {
                    yield {position, duration: this.length, pitch: radiusToPitch(radius), velocity: this.velocity, cent: 0}
                }
            }
        }
        if (!this.streams.state.active) return
        const state = this.streams.state
        state[0] = solver.size
        for (let index = 0; index < solver.size; index++) {
            state[1 + index * 2] = solver.radiusAt(index, solver.time)
            state[2 + index * 2] = solver.state[index]
        }
    }
}

class View {
    constructor(host) {
        this.host = host
        this.state = new Float32Array(1 + MAX_CIRCLES * 2)
        this.canvas = document.createElement("canvas")
        host.root.style.cssText = "box-sizing: border-box; padding: 4px"
        this.canvas.style.cssText = "width: 100%; height: 100%; display: block; border-radius: 4px; touch-action: none; cursor: crosshair"
        host.root.append(this.canvas)
        host.data.circles.subscribe(() => this.draw())
        host.streams.state.subscribe(values => {
            this.state.set(values)
            this.draw()
        })
        new ResizeObserver(() => this.draw()).observe(this.canvas)
        this.canvas.addEventListener("pointerdown", event => this.press(event))
        this.draw()
    }
    fit() {
        const width = this.canvas.clientWidth, height = this.canvas.clientHeight
        const scale = Math.min(width / WIDTH, height / HEIGHT)
        return {width, height, scale, left: (width - WIDTH * scale) / 2, top: (height - HEIGHT * scale) / 2}
    }
    clearBounds(width) {return {x: width - 36, y: 2, width: 34, height: 14}}
    press(event) {
        const {width, scale, left, top} = this.fit()
        const circles = this.host.data.circles
        const clear = this.clearBounds(width)
        if (circles.length > 0 && event.offsetX >= clear.x && event.offsetY <= clear.y + clear.height) {
            this.host.edit(() => {for (let index = circles.length - 1; index >= 0; index--) circles.remove(index)})
            return
        }
        const x = (event.offsetX - left) / scale, y = (event.offsetY - top) / scale
        if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) return
        const values = {x: x / WIDTH, y: y / HEIGHT}
        if (circles.length < MAX_CIRCLES) {
            circles.insert(circles.length, values)
            return
        }
        for (let index = 0; index < circles.length; index++) {
            if (!this.isVisible(index)) {
                circles.set(index, values)
                return
            }
        }
    }
    // a retired ring has outgrown the field, its slot takes the next click once all 64 are used
    isVisible(index) {return index >= this.state[0] || this.state[2 + index * 2] !== RETIRED}
    draw() {
        const ratio = devicePixelRatio
        const {width, height, scale, left, top} = this.fit()
        this.canvas.width = width * ratio
        this.canvas.height = height * ratio
        const context = this.canvas.getContext("2d")
        context.scale(ratio, ratio)
        context.lineWidth = 1
        context.setLineDash([2, 2])
        context.strokeStyle = this.host.color("displayGrid", 0.12)
        context.strokeRect(left + 0.5, top + 0.5, WIDTH * scale - 1, HEIGHT * scale - 1)
        context.setLineDash([])
        const circles = this.host.data.circles
        const streamed = Math.min(this.state[0], circles.length)
        context.fillStyle = this.host.color("displayStroke", 0.5)
        context.strokeStyle = this.host.color("displayStroke", 0.75)
        context.beginPath()
        for (let index = 0; index < circles.length; index++) {
            if (!this.isVisible(index)) continue
            const circle = circles.get(index)
            const x = left + circle.x * WIDTH * scale, y = top + circle.y * HEIGHT * scale
            context.fillRect(x - 1, y - 1, 2, 2)
            const radius = index < streamed ? this.state[1 + index * 2] * scale : 0
            if (radius <= 0) continue
            context.moveTo(x + radius, y)
            context.arc(x, y, radius, 0, Math.PI * 2)
        }
        context.stroke()
        context.font = `9px ${getComputedStyle(this.canvas).fontFamily}`
        context.fillStyle = "rgba(255, 255, 255, 0.2)"
        if (circles.length === 0) {
            context.textAlign = "center"
            context.fillText("Click to place a circle.", width / 2, height / 2 + 3)
        } else {
            const clear = this.clearBounds(width)
            context.textAlign = "right"
            context.fillText("Clear", clear.x + clear.width - 2, clear.y + 10)
        }
    }
}
