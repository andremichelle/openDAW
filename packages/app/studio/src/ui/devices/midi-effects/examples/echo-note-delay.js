// Echo / Note Delay
// @param repeats 3 1 8 int
// @param delay 120 24 480 int
// @param decay 0.7 0.1 1.0 linear
// @param duration 120 24 480 int

class Processor {
    repeats = 3
    delay = 120
    decay = 0.7
    duration = 120
    paramChanged(name, value) {
        if (name === "repeats") this.repeats = value
        if (name === "delay") this.delay = value
        if (name === "decay") this.decay = value
        if (name === "duration") this.duration = value
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate) {
                const dur = Math.min(event.duration, this.duration)
                for (let i = 0; i < this.repeats; i++) {
                    yield {
                        position: event.position + i * this.delay,
                        duration: dur,
                        pitch: event.pitch,
                        velocity: event.velocity * Math.pow(this.decay, i),
                        cent: event.cent
                    }
                }
            }
        }
    }
}