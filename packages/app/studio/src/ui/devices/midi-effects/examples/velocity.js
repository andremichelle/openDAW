// @label Velocity
// @param target 0.5 0 1 linear
// @param strength 0 0 1 linear
// @param randomAmount 0 0 1 linear
// @param offset 0 -1 1 linear
// @param mix 1 0 1 linear

class Processor {
    target = 0.5
    strength = 0
    randomAmount = 0
    offset = 0
    mix = 1
    paramChanged(name, value) {
        if (name === "target") this.target = value
        if (name === "strength") this.strength = value
        if (name === "randomAmount") this.randomAmount = value
        if (name === "offset") this.offset = value
        if (name === "mix") this.mix = value
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate) {
                const magnet = event.velocity + (this.target - event.velocity) * this.strength
                const random = (Math.random() * 2 - 1) * this.randomAmount
                const wet = Math.max(0, Math.min(1, magnet + random + this.offset))
                const velocity = event.velocity * (1 - this.mix) + wet * this.mix
                yield { ...event, velocity }
            }
        }
    }
}