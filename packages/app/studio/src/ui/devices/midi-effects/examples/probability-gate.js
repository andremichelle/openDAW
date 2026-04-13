// @label Probability Gate
// @param chance 0.5 0 1 linear

class Processor {
    chance = 0.5
    paramChanged(name, value) {
        if (name === "chance") this.chance = value
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate && Math.random() < this.chance) {
                yield event
            }
        }
    }
}