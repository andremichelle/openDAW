// @spielwerk strum 1 1
// @label Strummer
// @param speed 0.05 0.005 0.1 linear s
// @param direction 0 0 2 int
// @param spread 1 0 3 linear
// @param velocity 0.8 0.1 1 linear

class Processor {
    speed = 0.05
    direction = 0
    spread = 1
    velocity = 0.8
    sr = sampleRate

    paramChanged(label, value) {
        this[label] = value
    }

    *process(block, events) {
        const ppqn = 960
        const strumPpqn = Math.round(this.speed * ppqn)
        const dir = Math.round(this.direction)
        const spreadAmt = this.spread

        for (const ev of events) {
            if (ev.gate) {
                // collect all notes in this block at same position
                // strum them sequentially
                const notes = [{pitch: ev.pitch, vel: ev.velocity, pos: ev.position}]
                const basePos = ev.position
                const basePitch = ev.pitch

                // sort by pitch
                notes.sort((a, b) => a.pitch - b.pitch)

                // direction: 0=up, 1=down, 2=random
                if (dir === 1) {
                    notes.reverse()
                }

                for (let i = 0; i < notes.length; i++) {
                    const offset = i * strumPpqn * spreadAmt
                    yield {
                        position: basePos + offset,
                        duration: ev.duration - offset,
                        pitch: notes[i].pitch,
                        velocity: this.velocity * (1 - i * 0.03),
                        cent: 0
                    }
                }
            }
        }
    }

    reset() {}
}
