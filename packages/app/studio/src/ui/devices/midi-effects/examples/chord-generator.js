// Chord Generator
// @param mode

class Processor {
    intervals = [[0, 4, 7], [0, 3, 7], [0, 4, 7, 11], [0, 3, 7, 10]]
    mode = 0
    paramChanged(name, value) {
        if (name === "mode") this.mode = Math.min(3, Math.floor(value * 4))
    }
    * process(block, events) {
        for (const event of events) {
            if (event.gate) {
                for (const interval of this.intervals[this.mode]) {
                    yield { ...event, pitch: event.pitch + interval }
                }
            }
        }
    }
}