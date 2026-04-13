class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) {
        this.voices.push({
            id, velocity,
            freq: 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12),
            phase: 0, gain: 0, gate: true, fadeRate: 0.002
        })
    }
    noteOff(id) {
        const voice = this.voices.find(v => v.id === id)
        if (voice) voice.gate = false
    }
    reset() {
        for (const voice of this.voices) {
            voice.gate = false
            voice.fadeRate = 0.05
        }
    }
    process(output, block) {
        const [outL, outR] = output
        for (let i = this.voices.length - 1; i >= 0; i--) {
            const voice = this.voices[i]
            for (let s = block.s0; s < block.s1; s++) {
                if (voice.gate) {
                    voice.gain += (voice.velocity - voice.gain) * voice.fadeRate
                } else {
                    voice.gain -= voice.gain * voice.fadeRate
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