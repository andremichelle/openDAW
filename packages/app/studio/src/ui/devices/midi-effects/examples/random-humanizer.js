// @label Random Humanizer
// @param timing 10 0 50 linear
// @param velRange 0.1 0 0.3 linear

class Processor {
    timing = 10
    velRange = 0.1
    paramChanged(name, value) {
        if (name === "timing") this.timing = value
        if (name === "velRange") this.velRange = value
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate) {
                yield {
                    ...event,
                    position: event.position + Math.random() * this.timing,
                    velocity: Math.max(0, Math.min(1, event.velocity + (Math.random() - 0.5) * this.velRange))
                }
            }
        }
    }
}