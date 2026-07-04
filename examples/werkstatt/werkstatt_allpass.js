// @werkstatt allpass 1 1
// @label Allpass Filter
// @param freq 1000 20 20000 exp Hz
// @param stages 4 1 8 int
// @param invert 0 0 1 bool
// @param feedback 0 0 0.9 linear
// @param mix 1 0 1 linear

class Processor {
  p = {freq: 1000, stages: 4, invert: 0, feedback: 0, mix: 1}
  sr = sampleRate
  fb = [0, 0]

  constructor() {
    this.ap = []
    for (let c = 0; c < 2; c++) {
      this.ap.push(new Array(8).fill(0).map(() => ({z1: 0})))
    }
  }

  paramChanged(name, value) {
    this.p[name] = value
  }

  // 1st-order allpass (stable)
  _ap1(x, state, freq) {
    const tanw = Math.tan(Math.PI * Math.min(freq, this.sr * 0.49) / this.sr)
    const a = (1 - tanw) / (1 + tanw)
    const y = -a * x + state.z1
    state.z1 = x + a * y
    return y
  }

  process(io, block) {
    const freq = this.p.freq
    const stages = Math.round(this.p.stages)
    const invert = this.p.invert > 0.5
    const feedback = this.p.feedback
    const mix = this.p.mix
    for (let i = block.s0; i < block.s1; i++) {
      for (let c = 0; c < 2; c++) {
        const dry = io.src[c][i]
        let s = dry + this.fb[c] * feedback
        for (let st = 0; st < stages; st++) {
          s = this._ap1(s, this.ap[c][st], freq)
        }
        this.fb[c] = s
        const out = invert ? -s : s
        io.out[c][i] = dry * (1 - mix) + out * mix
      }
    }
  }
}
