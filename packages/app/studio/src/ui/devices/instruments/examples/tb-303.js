// @label TB-303 Bass Line
// @param waveform   false
// @param tuning     0     -12   12     linear  st
// @param cutoff     80    60    300    exp     Hz
// @param resonance  1.0   0     1      linear
// @param envmod     0.0   0     1      linear
// @param decay      300   200   2000   exp     ms
// @param accent     1.0   0     1      linear
// @param volume     0.7   0     1      linear

class Processor {
    waveform = 0
    tuning = 0
    cutoffHz = 80
    resonance = 0.8
    envmod = 0.2
    decayMs = 300
    accentAmount = 1.0
    volume = 0.7
    phase = 0
    freqTarget = 220
    freqSmoothed = 220
    y1 = 0
    y2 = 0
    y3 = 0
    y4 = 0
    fbHpState = 0
    oscHpState = 0
    postHpState = 0
    vcaGate = 0
    vcaDecay = 0
    megEnv = 0
    megDecayCoeff = 0.9999
    vcaDecayCoeff = 0.9999
    vcaGateCoeff = 0.999
    accentCap = 0
    isAccented = false
    gate = false
    sliding = false
    heldNotes = []
    cutoffSmoothed = 200
    ampSmoothed = 0
    paramChanged(name, value) {
        switch (name) {
            case "waveform": this.waveform = value; break
            case "tuning": this.tuning = value; break
            case "cutoff": this.cutoffHz = value; break
            case "resonance": this.resonance = value; break
            case "envmod": this.envmod = value; break
            case "decay": this.decayMs = value; break
            case "accent": this.accentAmount = value; break
            case "volume": this.volume = value; break
        }
    }
    noteOn(pitch, velocity, cent, id) {
        const freq = 440 * Math.pow(2, (pitch - 69 + cent / 100 + this.tuning) / 12)
        const isSlide = this.heldNotes.length > 0
        this.heldNotes.push({id, pitch, cent})
        this.freqTarget = freq
        if (isSlide) {
            this.sliding = true
        } else {
            this.sliding = false
            this.freqSmoothed = freq
            this.gate = true
            this.vcaDecay = 1.0
            this.megEnv = 1.0
            this.isAccented = velocity >= 1.0
            if (this.isAccented) {
                this.megDecayCoeff = Math.exp(-1 / (0.2 * sampleRate))
                this.vcaDecayCoeff = Math.exp(-1 / (0.2 * sampleRate))
                this.vcaGateCoeff = Math.exp(-1 / (0.05 * sampleRate))
            } else {
                this.megDecayCoeff = Math.exp(-1 / (this.decayMs * 0.001 * sampleRate))
                this.vcaDecayCoeff = Math.exp(-1 / (1.23 * sampleRate))
                this.vcaGateCoeff = Math.exp(-1 / (0.001 * sampleRate))
            }
        }
    }
    noteOff(id) {
        this.heldNotes = this.heldNotes.filter(note => note.id !== id)
        if (this.heldNotes.length === 0) {
            this.gate = false
            this.sliding = false
        } else {
            const prev = this.heldNotes[this.heldNotes.length - 1]
            this.freqTarget = 440 * Math.pow(2, (prev.pitch - 69 + prev.cent / 100 + this.tuning) / 12)
            this.sliding = true
        }
    }
    reset() {
        this.gate = false
        this.sliding = false
        this.vcaGate = 0
        this.ampSmoothed = 0
        this.vcaGateCoeff = Math.exp(-1 / (0.005 * sampleRate))
        this.heldNotes = []
    }
    process(output, block) {
        const [outL, outR] = output
        const sr = sampleRate
        const invSr = 1 / sr
        const sr2 = sr * 2
        const PI = Math.PI
        const gateAttack = 1 - Math.exp(-1 / (0.003 * sr))
        const slideAlpha = 1 - Math.exp(-1 / (0.012 * sr))
        const accChargeAlpha = 1 - Math.exp(-1 / (0.147 * sr))
        const accDischargeMul = Math.exp(-1 / (0.1 * sr))
        const resoSkewed = this.resonance * this.resonance
        const kFeedback = resoSkewed * 28
        const gNorm = kFeedback / 17
        let gComp = (gNorm - 1) * resoSkewed + 1
        gComp *= (1 + resoSkewed)
        const fbHpAlpha = 1 - Math.exp(-2 * PI * 150 / sr2)
        const oscHpAlpha = 1 - Math.exp(-2 * PI * 44 / sr)
        const postHpAlpha = 1 - Math.exp(-2 * PI * 24 / sr)
        const cutoffAlpha = 1 - Math.exp(-1 / (0.0005 * sr))
        const ampAlpha = 1 - Math.exp(-1 / (0.0005 * sr))
        const envDepth = 1.5 + this.envmod * 4.0
        const envOffset = this.envmod * 0.33
        for (let s = block.s0; s < block.s1; s++) {
            if (this.sliding) {
                this.freqSmoothed += (this.freqTarget - this.freqSmoothed) * slideAlpha
            } else {
                this.freqSmoothed = this.freqTarget
            }
            const freq = this.freqSmoothed
            const phaseInc = freq * invSr
            let osc = 0
            if (this.waveform === 0) {
                osc = 2 * this.phase - 1
                if (this.phase < phaseInc) {
                    const t = this.phase / phaseInc
                    osc -= t + t - t * t - 1
                } else if (this.phase > 1 - phaseInc) {
                    const t = (this.phase - 1) / phaseInc
                    osc -= t * t + t + t + 1
                }
            } else {
                const duty = Math.max(0.1, Math.min(0.9, 0.71 - 0.26 * (freq - 65) / 595))
                osc = this.phase < duty ? 1 : -1
                if (this.phase < phaseInc) {
                    const t = this.phase / phaseInc
                    osc += t + t - t * t - 1
                } else if (this.phase > 1 - phaseInc) {
                    const t = (this.phase - 1) / phaseInc
                    osc += t * t + t + t + 1
                }
                let rd = this.phase - duty
                if (rd < 0) rd += 1
                if (rd < phaseInc && rd >= 0) {
                    const t = rd / phaseInc
                    osc -= t + t - t * t - 1
                } else if (rd > 1 - phaseInc) {
                    const t = (rd - 1) / phaseInc
                    osc -= t * t + t + t + 1
                }
            }
            this.oscHpState += oscHpAlpha * (osc - this.oscHpState)
            osc -= this.oscHpState
            this.megEnv *= this.megDecayCoeff
            if (this.isAccented && this.gate) {
                this.accentCap += accChargeAlpha * (this.megEnv * this.accentAmount - this.accentCap)
            } else {
                this.accentCap *= accDischargeMul
            }
            let targetCutoff = this.cutoffHz * Math.pow(2, envDepth * (this.megEnv - envOffset))
            if (this.isAccented) {
                targetCutoff *= Math.pow(2, this.accentAmount * this.megEnv * 2.5)
            }
            targetCutoff *= Math.pow(2, this.accentCap * 1.0)
            if (targetCutoff < 60) targetCutoff = 60
            if (targetCutoff > sr * 0.45) targetCutoff = sr * 0.45
            this.cutoffSmoothed += (targetCutoff - this.cutoffSmoothed) * cutoffAlpha
            const gf = Math.tan(PI * this.cutoffSmoothed / sr2)
            const b0 = gf / (1 + gf)
            for (let os = 0; os < 2; os++) {
                const fbRaw = kFeedback * this.y4
                this.fbHpState += fbHpAlpha * (fbRaw - this.fbHpState)
                const fbHp = fbRaw - this.fbHpState
                const y0 = Math.tanh(osc - fbHp)
                this.y1 += 2 * b0 * (y0 - this.y1 + this.y2)
                this.y1 = Math.tanh(this.y1)
                this.y2 += b0 * (this.y1 - 2 * this.y2 + this.y3)
                this.y2 = Math.tanh(this.y2)
                this.y3 += b0 * (this.y2 - 2 * this.y3 + this.y4)
                this.y3 = Math.tanh(this.y3)
                this.y4 += b0 * (this.y3 - 2 * this.y4)
                this.y4 = Math.tanh(this.y4)
            }
            let filtered = 2.5 * gComp * this.y4
            this.postHpState += postHpAlpha * (filtered - this.postHpState)
            filtered -= this.postHpState
            if (this.gate) {
                this.vcaGate += (1 - this.vcaGate) * gateAttack
            } else {
                this.vcaGate *= this.vcaGateCoeff
            }
            this.vcaDecay *= this.vcaDecayCoeff
            let amp = this.vcaGate * this.vcaDecay
            if (this.gate) {
                amp += 0.45 * this.megEnv
                if (this.isAccented) {
                    amp += this.accentAmount * 4.0 * this.megEnv
                }
            }
            this.ampSmoothed += (amp - this.ampSmoothed) * ampAlpha
            const sample = Math.tanh(filtered * this.ampSmoothed) * this.volume
            outL[s] += sample
            outR[s] += sample
            this.phase += phaseInc
            if (this.phase >= 1) this.phase -= 1
        }
    }
}