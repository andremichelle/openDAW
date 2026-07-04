// @spielwerk velocity 1 1
// @label Velocity Scaler
// @param scale 1 0 2 linear
// @param offset 0 -0.5 0.5 linear
// @param curve 1 0.1 4 linear
// @param min_vel 0 0 0.9 linear
// @param max_vel 1 0.1 1 linear

class Processor {
    scale = 1
    offset = 0
    curve = 1
    min_vel = 0
    max_vel = 1

    paramChanged(label, value) {
        this[label] = value
    }

    *process(block, events) {
        for (const ev of events) {
            let v = ev.velocity * this.scale + this.offset
            v = Math.pow(Math.max(0, v), this.curve)
            v = Math.max(this.min_vel, Math.min(this.max_vel, v))
            yield {
                position: ev.position,
                duration: ev.duration,
                pitch: ev.pitch,
                velocity: v,
                cent: ev.cent || 0
            }
        }
    }

    reset() {}
}
