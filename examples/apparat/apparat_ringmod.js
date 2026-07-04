// @apparat ringmod 1 1
// @label Ring Modulator Synth
// @param frequency 440 20 2000 exp Hz
// @param waveform 0 0 3 int
// @param attack 0.005 0.001 0.5 exp s
// @param decay 0.1 0.005 2 exp s
// @param sustain 0.6 0 1 linear
// @param release 0.2 0.01 3 exp s
// @param adsrAmount 0.8 0 1 linear
// @param subOsc 0 0 1 linear
// @param volume 0.7 0 1 linear

class Processor {
  p = {frequency: 440, waveform: 0, attack: 0.005, decay: 0.1, sustain: 0.6, release: 0.2, adsrAmount: 0.8, subOsc: 0, volume: 0.7}
  sr = sampleRate
  phase = 0
  subPhase = 0
  env = 0
  envState = 'idle' // idle/attack/decay/sustain/release
  noteOn = false
  currentFreq = 440

  constructor() {}

  paramChanged(name, value) {
    this.p[name] = value
  }

  // Called when a MIDI note-on event arrives
  noteOn(freq, velocity) {
    this.currentFreq = freq
    this.noteOn = true
    this.envState = 'attack'
  }

  // Called when a MIDI note-off event arrives
  noteOff() {
    this.noteOn = false
    this.envState = 'release'
  }

  _wave(phase, type) {
    const t = phase % 1
    switch (type) {
      case 0: return Math.sin(2 * Math.PI * t)          // sine
      case 1: return 2 * (t - Math.floor(t + 0.5))       // triangle
      case 2: return 2 * (t - Math.floor(t)) - 1         // saw
      case 3: return t < 0.5 ? 1 : -1                     // square
      default: return Math.sin(2 * Math.PI * t)
    }
  }

  process(output, block) {
    const sr = this.sr
    const baseFreq = this.p.frequency
    const subLevel = this.p.subOsc
    const vol = this.p.volume
    const adsrAmt = this.p.adsrAmount
    const a = this.p.attack
    const d = this.p.decay
    const s = this.p.sustain
    const r = this.p.release

    for (let i = block.s0; i < block.s1; i++) {
      // ADSR envelope
      const aSamp = Math.max(1, a * sr)
      const dSamp = Math.max(1, d * sr)
      const rSamp = Math.max(1, r * sr)

      switch (this.envState) {
        case 'attack':
          this.env += 1 / aSamp
          if (this.env >= 1) { this.env = 1; this.envState = 'decay' }
          break
        case 'decay':
          this.env += (s - 1) / dSamp
          if (this.env <= s) { this.env = s; this.envState = 'sustain' }
          break
        case 'sustain':
          this.env = s
          break
        case 'release':
          this.env -= this.env / rSamp
          if (this.env <= 0.001) { this.env = 0; this.envState = 'idle' }
          break
        case 'idle':
          this.env = 0
          break
      }

      // Carrier frequency modulated by ADSR
      const modFreq = baseFreq * (1 + adsrAmt * this.env * 0.5)
      this.phase += modFreq / sr
      this.subPhase += modFreq * 0.5 / sr // sub oscillator one octave down

      // Ring modulation: carrier × sub (sub acts as modulator)
      const carrier = this._wave(this.phase, this.p.waveform)
      const sub = this._wave(this.subPhase, 0) // sine sub
      let sample = carrier * (1 - subLevel + subLevel * sub)

      // Apply envelope and volume
      sample *= this.env * vol

      output[0][i] = sample
      if (output[1]) output[1][i] = sample
    }
  }
}
