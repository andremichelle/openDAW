// Grain Synthesizer
// @sample grain
// @param density 8 1 32 int
// @param size 0.2 0.01 0.5 exp s
// @param spread 0.5 0 1 linear
// @param pitch 0 -12 12 int

class Processor {
    density = 8
    size = 0.05
    spread = 0.5
    pitchShift = 0
    grains = []
    held = []
    paramChanged(name, value) {
        if (name === "density") this.density = value
        if (name === "size") this.size = value
        if (name === "spread") this.spread = value
        if (name === "pitch") this.pitchShift = value
    }
    noteOn(pitch, velocity, cent, id) {
        this.held.push({id, pitch, velocity, cent, elapsed: 0})
    }
    noteOff(id) {
        this.held = this.held.filter(note => note.id !== id)
    }
    reset() {
        this.held = []
        this.grains = []
    }
    process(output, block) {
        const data = this.samples.grain
        if (data === null || data.numberOfFrames === 0) return
        const [outL, outR] = output
        const rate = data.sampleRate / sampleRate
        const srcL = data.frames[0]
        const srcR = data.frames[data.numberOfChannels > 1 ? 1 : 0]
        const interval = sampleRate / this.density
        const grainSamples = Math.round(this.size * sampleRate)
        for (const note of this.held) {
            const playbackRate = rate * Math.pow(2, (note.pitch - 60 + note.cent / 100 + this.pitchShift) / 12)
            for (let s = block.s0; s < block.s1; s++) {
                if (note.elapsed % Math.round(interval) === 0) {
                    const offset = Math.random() * this.spread * data.numberOfFrames
                    this.grains.push({
                        position: offset,
                        age: 0,
                        length: grainSamples,
                        rate: playbackRate,
                        velocity: note.velocity,
                        pan: Math.random() * 2 - 1
                    })
                }
                note.elapsed++
            }
        }
        for (let i = this.grains.length - 1; i >= 0; i--) {
            const grain = this.grains[i]
            for (let s = block.s0; s < block.s1; s++) {
                if (grain.age >= grain.length) {
                    this.grains.splice(i, 1)
                    break
                }
                const env = Math.sin(grain.age / grain.length * Math.PI)
                const pos = Math.floor(grain.position) % data.numberOfFrames
                const sample = srcL[pos] * env * grain.velocity * 0.2
                const sampleR = srcR[pos] * env * grain.velocity * 0.2
                const panL = 1 - Math.max(0, grain.pan)
                const panR = 1 + Math.min(0, grain.pan)
                outL[s] += sample * panL
                outR[s] += sampleR * panR
                grain.position += grain.rate
                grain.age++
            }
        }
    }
}