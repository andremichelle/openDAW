// @spielwerk chordmemory 1 1
// @label Chord Memory
// @param chord 0 0 6 int
// @param octave 0 -2 2 int
// @param velocity 0.8 0.1 1 linear

class Processor {
    chord = 0
    octave = 0
    velocity = 0.8

    // chord shapes relative to root
    shapes = [
        [0, 4, 7],       // 0: major
        [0, 3, 7],       // 1: minor
        [0, 4, 7, 11],   // 2: maj7
        [0, 3, 7, 10],   // 3: min7
        [0, 4, 7, 10],   // 4: dom7
        [0, 3, 6],       // 5: dim
        [0, 4, 8],       // 6: aug
    ]

    paramChanged(label, value) {
        this[label] = value
    }

    *process(block, events) {
        const shape = this.shapes[Math.round(this.chord)] || this.shapes[0]
        const octShift = Math.round(this.octave) * 12
        for (const ev of events) {
            if (ev.gate) {
                const root = ev.pitch + octShift
                for (let i = 0; i < shape.length; i++) {
                    const p = root + shape[i]
                    if (p >= 0 && p <= 127) {
                        yield {
                            position: ev.position + i * 4,
                            duration: ev.duration,
                            pitch: p,
                            velocity: this.velocity * (1 - i * 0.05),
                            cent: 0
                        }
                    }
                }
            }
        }
    }

    reset() {}
}
