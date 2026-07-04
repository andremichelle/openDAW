// @spielwerk arpeggiator 1 1
// @label Arpeggiator
// @param rate 0.25 0.0625 4 linear
// @param octaves 2 1 4 linear
// @param direction 0 0 2 linear
// @param hold 0.85 0.1 1 linear
// @param velocity 0.8 0 1 linear
// @param swing 0 0 0.5 linear

class Processor {
    rate = 0.25
    octaves = 2
    direction = 0
    hold = 0.85
    velocity = 0.8
    swing = 0

    // held notes — sorted by pitch
    held = []
    // arpeggio state
    step = 0
    // note id counter
    nextId = 1000
    // active output notes (for note-off scheduling)
    active = new Map()

    paramChanged(name, value) {
        if (name === "rate") this.rate = value
        if (name === "octaves") this.octaves = Math.round(value)
        if (name === "direction") this.direction = Math.round(value)
        if (name === "hold") this.hold = value
        if (name === "velocity") this.velocity = value
        if (name === "swing") this.swing = value
    }

    reset() {
        this.held = []
        this.step = 0
        this.active.clear()
    }

    // build arpeggio pattern from held notes + octave spread
    buildPattern() {
        if (this.held.length === 0) return []
        const notes = [...this.held].sort((a, b) => a.pitch - b.pitch)
        const pattern = []
        const oct = this.octaves
        const dir = this.direction

        for (let o = 0; o < oct; o++) {
            const offset = o * 12
            for (const n of notes) {
                pattern.push(n.pitch + offset)
            }
        }

        // direction: 0=up, 1=down, 2=updown
        if (dir === 1) {
            pattern.reverse()
        } else if (dir === 2) {
            const down = [...pattern].reverse().slice(1, -1)
            pattern.push(...down)
        }

        return pattern
    }

    * process(block, events) {
        const ppqn = 960
        const ratePpqn = Math.round(this.rate * ppqn)
        if (ratePpqn <= 0) return

        // collect held notes from events
        for (const e of events) {
            if (e.gate) {
                // note on — add to held
                this.held.push({ id: e.id, pitch: e.pitch, velocity: e.velocity })
            } else {
                // note off — remove from held
                this.held = this.held.filter(n => n.id !== e.id)
                // also remove from active
                this.active.delete(e.id)
            }
        }

        if (this.held.length === 0) {
            // no held notes — yield nothing (silence)
            return
        }

        const pattern = this.buildPattern()
        if (pattern.length === 0) return

        // generate arpeggio notes within this block
        const from = block.p0
        const to = block.p1
        const swingAmt = this.swing * ratePpqn * 0.5

        let pos = from
        // align to rate grid
        const offset = from % ratePpqn
        if (offset !== 0) pos = from + (ratePpqn - offset)

        let localStep = this.step

        while (pos < to) {
            const noteIdx = localStep % pattern.length
            const pitch = pattern[noteIdx]

            // swing: odd steps delayed
            let notePos = pos
            if (localStep % 2 === 1) notePos += swingAmt
            if (notePos >= to) break

            const dur = Math.round(ratePpqn * this.hold)
            const id = this.nextId++

            yield {
                position: notePos,
                duration: dur,
                pitch: pitch,
                velocity: this.velocity,
                cent: 0
            }

            localStep++
            pos += ratePpqn
        }

        this.step = localStep
    }
}
