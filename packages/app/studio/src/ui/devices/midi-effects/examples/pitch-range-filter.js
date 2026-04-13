// @label Pitch Range Filter
// @param low 36 0 127 int
// @param high 84 0 127 int

class Processor {
    low = 36
    high = 84
    paramChanged(name, value) {
        if (name === "low") this.low = value
        if (name === "high") this.high = value
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate && event.pitch >= this.low && event.pitch <= this.high) {
                yield event
            }
        }
    }
}