// Pitch Range Filter
// @param low 0.28
// @param high 0.66

class Processor {
    low = 36
    high = 84
    paramChanged(name, value) {
        if (name === "low") this.low = Math.round(value * 127)
        if (name === "high") this.high = Math.round(value * 127)
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate && event.pitch >= this.low && event.pitch <= this.high) {
                yield event
            }
        }
    }
}