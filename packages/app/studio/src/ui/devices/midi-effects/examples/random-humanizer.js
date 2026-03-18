// Random Humanizer
// @param timing 0.2
// @param velRange 0.33

class Processor {
    timing = 10
    velRange = 0.1
    paramChanged(name, value) {
        if (name === "timing") this.timing = value * 50
        if (name === "velRange") this.velRange = value * 0.3
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