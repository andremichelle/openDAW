// @label Sidechain Gated Sine
// @sidechain Gate
// @param release 0.3 0.01 2.0 exp s

class Processor {
    voices = []
    release = 0.3
    envelope = 0
    paramChanged(name, value) {
        if (name === "release") this.release = value
    }
    noteOn(pitch, velocity, cent, id) {
        this.voices.push({id, gate: true, gain: velocity, freq: 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12), phase: 0})
    }
    noteOff(id) {
        const voice = this.voices.find(v => v.id === id)
        if (voice) voice.gate = false
    }
    reset() {
        this.voices.length = 0
        this.envelope = 0
    }
    process(output, block) {
        const [outL, outR] = output
        const [gateL, gateR] = this.sidechains.Gate
        const fall = Math.exp(-1 / (0.05 * sampleRate))
        const releaseRate = 1 / (this.release * sampleRate)
        for (let s = block.s0; s < block.s1; s++) {
            const level = Math.max(Math.abs(gateL[s]), Math.abs(gateR[s]))
            this.envelope = level > this.envelope ? level : this.envelope * fall
            let sum = 0
            for (const voice of this.voices) {
                if (!voice.gate) voice.gain -= voice.gain * releaseRate
                sum += Math.sin(voice.phase * Math.PI * 2) * voice.gain * 0.3
                voice.phase += voice.freq / sampleRate
            }
            outL[s] = sum * Math.min(1, this.envelope)
            outR[s] = sum * Math.min(1, this.envelope)
        }
        for (let i = this.voices.length - 1; i >= 0; i--) {
            const voice = this.voices[i]
            if (!voice.gate && voice.gain < 0.001) this.voices.splice(i, 1)
        }
    }
}
