// @label Pitch
// @param octaves 0 -4 4 int
// @param semiTones 0 -12 12 int
// @param cent 0 -100 100 linear

class Processor {
    octaves = 0
    semiTones = 0
    cent = 0
    paramChanged(name, value) {
        if (name === "octaves") this.octaves = value
        if (name === "semiTones") this.semiTones = value
        if (name === "cent") this.cent = value
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