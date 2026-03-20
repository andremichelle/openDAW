// 303 Sequencer
// @param seed     0     0     999    int
// @param length   16    1     32     int
// @param scale    2     0     5      int
// @param octave   3     1     4      int
// @param slides   0.2   0     1      linear
// @param accents  0.25  0     1      linear
// @param rests    0.15  0     1      linear

class Processor {
    seed = 0
    length = 16
    scale = 3
    octave = 3
    slideChance = 0.2
    accentChance = 0.25
    restChance = 0.15
    pattern = []
    dirty = true

    paramChanged(name, value) {
        if (name === "seed") this.seed = value
        if (name === "length") this.length = value
        if (name === "scale") this.scale = value
        if (name === "octave") this.octave = value
        if (name === "slides") this.slideChance = value
        if (name === "accents") this.accentChance = value
        if (name === "rests") this.restChance = value
        this.dirty = true
    }

    generate() {
        const scales = [
            [0, 2, 4, 5, 7, 9, 11],
            [0, 2, 3, 5, 7, 8, 10],
            [0, 2, 3, 5, 7, 9, 10],
            [0, 3, 5, 7, 10],
            [0, 3, 5, 6, 7, 10],
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
        ]
        const notes = scales[this.scale] || scales[0]
        const root = 12 + this.octave * 12
        let state = (this.seed * 2654435761 + 1) | 0
        const rand = () => {
            state = (state * 1664525 + 1013904223) | 0
            return (state >>> 0) / 4294967296
        }
        const randInt = (max) => Math.floor(rand() * max)
        this.pattern = []
        let prevDegree = 0
        for (let step = 0; step < this.length; step++) {
            const isRest = rand() < this.restChance
            const jump = rand()
            let degree
            if (jump < 0.5) {
                degree = prevDegree + (rand() < 0.5 ? 1 : -1)
            } else if (jump < 0.8) {
                degree = prevDegree + (rand() < 0.5 ? 2 : -2)
            } else {
                degree = randInt(notes.length)
            }
            degree = ((degree % notes.length) + notes.length) % notes.length
            const octaveShift = rand() < 0.12 ? 12 : (rand() < 0.08 ? -12 : 0)
            const pitch = Math.max(0, Math.min(127, root + notes[degree] + octaveShift))
            const accent = rand() < this.accentChance
            const slide = rand() < this.slideChance
            this.pattern.push({pitch, accent, slide, rest: isRest})
            prevDegree = degree
        }
    }

    * process(block, events) {
        if ((block.flags & 4) === 0) return
        if (this.dirty) {
            this.generate()
            this.dirty = false
        }
        const length = this.pattern.length
        if (length === 0) return
        const stepSize = 240
        let index = Math.ceil(block.from / stepSize)
        let position = index * stepSize
        while (position < block.to) {
            const entry = this.pattern[index % this.pattern.length]
            if (!entry.rest) {
                yield {
                    position: Math.max(position, block.from),
                    duration: entry.slide ? 260 : 140,
                    pitch: entry.pitch,
                    velocity: entry.accent ? 1.0 : 0.8,
                    cent: 0
                }
            }
            position = ++index * stepSize
        }
    }

    reset() {
    }
}