// @spielwerk mididelay 1 1
// @label MIDI Delay
// @param time 0.25 0.01 2 exp s
// @param feedback 0.5 0 0.9 linear
// @param repeats 4 1 16 int
// @param transpose 0 -12 12 int
// @param decay 0.7 0 1 linear

class Processor {
    time = 0.25
    feedback = 0.5
    repeats = 4
    transpose = 0
    decay = 0.7
    sr = sampleRate

    paramChanged(label, value) {
        this[label] = value
    }

    *process(block, events) {
        const ppqn = 960
        const delayPpqn = Math.round(this.time * ppqn)
        const maxRepeats = Math.round(this.repeats)
        const semis = Math.round(this.transpose)

        for (const ev of events) {
            // always pass the original
            yield {
                position: ev.position,
                duration: ev.duration,
                pitch: ev.pitch,
                velocity: ev.velocity,
                cent: ev.cent || 0
            }

            // generate delayed echoes
            if (ev.gate) {
                for (let r = 1; r <= maxRepeats; r++) {
                    const pos = ev.position + delayPpqn * r
                    const pitchShift = semis * r
                    const pitch = ev.pitch + pitchShift
                    const velDecay = Math.pow(this.decay, r)
                    const v = ev.velocity * this.feedback * velDecay
                    if (v < 0.01) break
                    if (pitch < 0 || pitch > 127) break
                    yield {
                        position: pos,
                        duration: Math.max(60, ev.duration - delayPpqn * (r - 1)),
                        pitch: pitch,
                        velocity: v,
                        cent: 0
                    }
                }
            }
        }
    }

    reset() {}
}
