// Echo / Note Delay
// @param repeats 0.3
// @param delay 0.25
// @param decay 0.7
// @param duration 0.25

class Processor {
    repeats = 3
    delay = 120
    decay = 0.7
    duration = 120
    paramChanged(name, value) {
        if (name === "repeats") this.repeats = Math.round(1 + value * 7)
        if (name === "delay") this.delay = Math.round(24 + value * 456)
        if (name === "decay") this.decay = 0.1 + value * 0.9
        if (name === "duration") this.duration = Math.round(24 + value * 456)
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