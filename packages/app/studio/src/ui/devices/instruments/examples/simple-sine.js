// Simple Sine Synth
// @param attack 0.01 0.001 1.0 exp s
// @param release 0.3 0.01 2.0 exp s

class Processor {
    voices = []
    attack = 0.01
    release = 0.3
    paramChanged(name, value) {
        if (name === "attack") this.attack = value
        if (name === "release") this.release = value
    }
    noteOn(pitch, velocity, cent, id) {
        this.voices.push({
            id, velocity,
            freq: 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12),
            phase: 0, gain: 0, target: velocity, gate: true, releaseTime: this.release
        })
    }
    noteOff(id) {
        const voice = this.voices.find(v => v.id === id)
        if (voice) voice.gate = false
    }
    reset() {
        for (const voice of this.voices) {
            voice.gate = false
            voice.releaseTime = 0.005
        }
    }
    process(output, block) {
        const [outL, outR] = output
        const attackRate = 1 / (this.attack * sampleRate)
        for (let i = this.voices.length - 1; i >= 0; i--) {
            const voice = this.voices[i]
            const releaseRate = 1 / (voice.releaseTime * sampleRate)
            for (let s = block.s0; s < block.s1; s++) {
                if (voice.gate) {
                    voice.gain += (voice.target - voice.gain) * attackRate
                } else {
                    voice.gain -= voice.gain * releaseRate
                    if (voice.gain < 0.001) {
                        this.voices.splice(i, 1)
                        break
                    }
                }
                const sample = Math.sin(voice.phase * Math.PI * 2) * voice.gain * 0.3
                outL[s] += sample
                outR[s] += sample
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}