// Pitch
// @param octaves 0.5
// @param semiTones 0.5
// @param cent 0.5

class Processor {
    octaves = 0
    semiTones = 0
    cent = 0
    paramChanged(name, value) {
        if (name === "octaves") this.octaves = Math.round(value * 8 - 4)
        if (name === "semiTones") this.semiTones = Math.round(value * 24 - 12)
        if (name === "cent") this.cent = value * 200 - 100
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate) {
                yield {
                    ...event,
                    pitch: event.pitch + this.octaves * 12 + this.semiTones,
                    cent: event.cent + this.cent
                }
            }
        }
    }
}