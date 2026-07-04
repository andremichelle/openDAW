// @spielwerk powerchord 1 1
// @label Power Chord
// @param interval 7 0 24 int
// @param interval2 12 0 24 int
// @param velScale 0.85 0.1 1 linear
// @param detune 3 0 50 int

class Processor {
    heldNotes = new Map()
    interval = 7
    interval2 = 12
    velScale = 0.85
    detune = 3;

    *process(block, events) {
        const detuneAmt = this.detune / 100

        for (const ev of events) {
            if (ev.gate) {
                this.heldNotes.set(ev.pitch, {id: ev.id, velocity: ev.velocity})

                // Root note
                yield {
                    position: ev.position,
                    duration: ev.duration,
                    pitch: ev.pitch,
                    velocity: ev.velocity,
                    cent: ev.cent || 0
                }

                // Fifth
                if (this.interval > 0 && ev.pitch + this.interval <= 127) {
                    yield {
                        position: ev.position + 8,
                        duration: ev.duration,
                        pitch: ev.pitch + this.interval,
                        velocity: ev.velocity * this.velScale,
                        cent: (ev.cent || 0) + detuneAmt
                    }
                }

                // Octave
                if (this.interval2 > 0 && ev.pitch + this.interval2 <= 127) {
                    yield {
                        position: ev.position + 16,
                        duration: ev.duration,
                        pitch: ev.pitch + this.interval2,
                        velocity: ev.velocity * this.velScale * 0.9,
                        cent: (ev.cent || 0) - detuneAmt
                    }
                }
            } else {
                this.heldNotes.delete(ev.pitch)
            }
        }
    }

    paramChanged(label, value) {
        this[label] = value
    }

    reset() {
        this.heldNotes.clear()
    }
}
