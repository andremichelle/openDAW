// @apparat coldlead 1 1
// @label Cold Lead
// @param waveform 1 0 3 int
// @param cutoff 1200 50 8000 exp Hz
// @param resonance 2.0 0.1 8 linear
// @param attack 0.01 0.001 0.5 exp s
// @param decay 0.4 0.01 4 exp s
// @param sustain 0.3 0 1 linear
// @param release 1.2 0.01 8 exp s
// @param detune 0.2 0 0.5 linear
// @param volume 0.5 0 1 linear

class Processor {
    voices = []
    
    waveform = 1
    cutoff = 1200
    resonance = 2.0
    attack = 0.01
    decay = 0.4
    sustain = 0.3
    release = 1.2
    detune = 0.2
    volume = 0.5
    
    b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0
    
    constructor(opts) {
        this.sr = (opts && opts.sampleRate) ? opts.sampleRate : 48000
        this.recalcFilter()
    }
    
    recalcFilter() {
        const w0 = 2 * Math.PI * this.cutoff / this.sr
        const alpha = Math.sin(w0) / (2 * this.resonance)
        const cosw0 = Math.cos(w0)
        const a0 = 1 + alpha
        this.b0 = ((1 - cosw0) / 2) / a0
        this.b1 = (1 - cosw0) / a0
        this.b2 = ((1 - cosw0) / 2) / a0
        this.a1 = (-2 * cosw0) / a0
        this.a2 = (1 - alpha) / a0
    }
    
    paramChanged(name, value) {
        if (name === "waveform") this.waveform = Math.floor(value)
        if (name === "cutoff") { this.cutoff = value; this.recalcFilter() }
        if (name === "resonance") { this.resonance = value; this.recalcFilter() }
        if (name === "attack") this.attack = value
        if (name === "decay") this.decay = value
        if (name === "sustain") this.sustain = value
        if (name === "release") this.release = value
        if (name === "detune") this.detune = value
        if (name === "volume") this.volume = value
    }
    
    noteOn(pitch, velocity, cent, id) {
        const freq = 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)
        this.voices.push({
            id, velocity,
            freq, freqDet: freq * (1 + this.detune * 0.01),
            phase: 0, phaseDet: Math.random() * 0.5,
            gate: true,
            env: 0,
            envState: 'attack',
            envRate: 1 / (this.attack * this.sr),
            x1: 0, x2: 0, y1: 0, y2: 0,
        })
    }
    
    noteOff(id) {
        const v = this.voices.find(v => v.id === id)
        if (v) {
            v.gate = false
            v.envState = 'release'
            v.envRate = 1 / (this.release * this.sr)
        }
    }
    
    reset() {
        for (const v of this.voices) {
            v.gate = false
            v.envState = 'release'
            v.envRate = 1 / (0.05 * this.sr)
        }
    }
    
    wave(phase, type) {
        if (type === 0) return Math.sin(phase * Math.PI * 2)
        if (type === 1) {
            const p = phase % 1
            return p < 0.5 ? 4 * p - 1 : 3 - 4 * p
        }
        if (type === 2) {
            const p = phase % 1
            return 2 * p - 1
        }
        const p = phase % 1
        return p < 0.5 ? 1 : -1
    }
    
    process(output, block) {
        const [outL, outR] = output
        const sr = this.sr
        const vol = this.volume
        const detune = this.detune
        const wf = this.waveform
        const sustainLvl = this.sustain
        const decayRate = 1 / (this.decay * sr)
        const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2
        
        for (let i = this.voices.length - 1; i >= 0; i--) {
            const v = this.voices[i]
            const phaseInc = v.freq / sr
            const detPhaseInc = v.freqDet / sr
            
            for (let s = block.s0; s < block.s1; s++) {
                if (v.envState === 'attack') {
                    v.env += v.envRate
                    if (v.env >= 1) {
                        v.env = 1
                        v.envState = 'decay'
                        v.envRate = decayRate
                    }
                } else if (v.envState === 'decay') {
                    v.env -= v.envRate
                    if (v.env <= sustainLvl) {
                        v.env = sustainLvl
                        v.envState = 'sustain'
                    }
                } else if (v.envState === 'release') {
                    v.env -= v.envRate
                    if (v.env <= 0) {
                        v.env = 0
                        this.voices.splice(i, 1)
                        break
                    }
                }
                
                const osc1 = this.wave(v.phase, wf)
                const osc2 = detune > 0 ? this.wave(v.phaseDet, wf) * 0.4 : 0
                const sig = (osc1 + osc2) * v.env * v.velocity * vol
                
                const filtered = b0 * sig + b1 * v.x1 + b2 * v.x2 - a1 * v.y1 - a2 * v.y2
                v.x2 = v.x1; v.x1 = sig
                v.y2 = v.y1; v.y1 = filtered
                
                outL[s] += filtered * 0.5
                outR[s] += filtered * 0.5
                
                v.phase += phaseInc
                v.phaseDet += detPhaseInc
            }
        }
    }
}
