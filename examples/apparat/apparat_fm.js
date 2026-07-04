// @apparat fm 1 1
// @label FM Synth (2-op)
// @param carrier 220 50 4000 exp Hz
// @param ratio 2 0.25 16 linear
// @param mod_depth 800 0 8000 linear Hz
// @param waveform 0 0 3 int
// @param attack 0.005 0.001 2 exp s
// @param decay 0.2 0.01 4 exp s
// @param sustain 0.7 0 1 linear
// @param release 0.3 0.01 4 exp s
// @param volume 0.7 0 1 linear

class Processor {
  p = {carrier: 220, ratio: 2, mod_depth: 800, waveform: 0, attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.3, volume: 0.7}
  sr = sampleRate
  phase = 0
  modPhase = 0
  env = 0
  envState = 0
  noteFreq = 220
  noteOn = false

  paramChanged(name, value) {
    this.p[name] = value
  }

  _wave(phase, w) {
    if (w === 0) return Math.sin(phase)
    if (w === 1) return 2 * (phase / (2 * Math.PI) - Math.floor(phase / (2 * Math.PI) + 0.5))
    if (w === 2) {
      const t = (phase / (2 * Math.PI)) % 1
      return t < 0.5 ? 1 : -1
    }
    // square
    return Math.sin(phase) > 0 ? 1 : -1
  }

  noteOn(freq, velocity) {
    this.noteFreq = freq
    this.noteOn = true
    this.envState = 1
    this.env = 0
  }

  noteOff() {
    this.noteOn = false
    this.envState = 4
  }

  process(output, block) {
    const sr = this.sr
    const carrierFreq = this.p.carrier
    const ratio = this.p.ratio
    const modFreq = carrierFreq * ratio
    const modDepth = this.p.mod_depth
    const wave = Math.round(this.p.waveform)
    const vol = this.p.volume
    const aCoef = Math.exp(-1 / (this.p.attack * sr))
    const dCoef = Math.exp(-1 / (this.p.decay * sr))
    const sLevel = this.p.sustain
    const rCoef = Math.exp(-1 / (this.p.release * sr))
    for (let i = block.s0; i < block.s1; i++) {
      // Envelope ADSR
      if (this.envState === 1) {
        this.env += (1 - this.env) * (1 - aCoef)
        if (this.env >= 0.999) this.envState = 2
      } else if (this.envState === 2) {
        this.env += (sLevel - this.env) * (1 - dCoef)
        if (Math.abs(this.env - sLevel) < 0.001) this.envState = 3
      } else if (this.envState === 3) {
        this.env = sLevel
      } else if (this.envState === 4) {
        this.env *= rCoef
        if (this.env < 0.0001) this.envState = 0
      }
      // FM: carrier phase modulated by modulator
      const modSig = this._wave(this.modPhase, wave) * modDepth * this.env
      const sample = this._wave(this.phase + modSig, wave) * this.env * vol
      this.phase += 2 * Math.PI * carrierFreq / sr
      this.modPhase += 2 * Math.PI * modFreq / sr
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI
      if (this.modPhase > 2 * Math.PI) this.modPhase -= 2 * Math.PI
      output[0][i] = sample
      output[1][i] = sample
    }
  }
}
