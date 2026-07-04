// @werkstatt phaser 1 1
// @label Phaser
// @param rate 0.3 0.05 8 exp Hz
// @param depth 0.5 0 1 linear
// @param feedback 0.3 0 0.9 linear
// @param stages 4 2 8 int
// @param mix 0.5 0 1 linear

class Processor {
  p = {rate: 0.3, depth: 0.5, feedback: 0.3, stages: 4, mix: 0.5}
  sr = sampleRate
  phase = 0
  fb = [0, 0]

  constructor() {
    // Allpass states for 8 stages, stereo
    this.ap = []
    for (let c = 0; c < 2; c++) {
      this.ap.push(new Array(8).fill(0).map(() => ({z1: 0})))
    }
  }

  paramChanged(name, value) {
    this.p[name] = value
  }

  // 1st-order allpass (stable) — used in cascade
  _ap1(x, state, freq) {
    const tanw = Math.tan(Math.PI * freq / this.sr)
    const a = (1 - tanw) / (1 + tanw)
    const y = -a * x + state.z1
    state.z1 = x + a * y
    return y
  }

  process(io, block) {
    const rate = this.p.rate
    const depth = this.p.depth
    const feedback = this.p.feedback
    const stages = Math.round(this.p.stages)
    const mix = this.p.mix

    for (let i = block.s0; i < block.s1; i++) {
      this.phase += 2 * Math.PI * rate / this.sr
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI

      // LFO sweeps 200..8000 Hz
      const lfo = (Math.sin(this.phase) + 1) * 0.5
      const sweepFreq = 200 + depth * 7800 * lfo

      for (let c = 0; c < 2; c++) {
        const dry = io.src[c][i]
        let s = dry + this.fb[c] * feedback

        // Cascade 1st-order allpass stages
        for (let st = 0; st < stages; st++) {
          s = this._ap1(s, this.ap[c][st], sweepFreq)
        }

        this.fb[c] = s
        io.out[c][i] = dry * (1 - mix) + s * mix
      }
    }
  }
}
