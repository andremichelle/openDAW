// Chord Generator
// @param mode 0 0 3 int

class Processor {
    intervals = [[0, 4, 7], [0, 3, 7], [0, 4, 7, 11], [0, 3, 7, 10]]
    mode = 0
    paramChanged(name, value) {
        if (name === "mode") this.mode = value
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