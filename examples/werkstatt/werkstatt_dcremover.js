// @werkstatt dcremover 1 1
// @label DC Remover + Stereo Tool
// @param dc_freq 2 0.5 20 exp Hz
// @param width 1 0 1 linear
// @param balance 0 -1 1 linear
// @param mix 1 0 1 linear

class Processor {
  p = {dc_freq: 2, width: 1, balance: 0, mix: 1}
  sr = sampleRate
  dcL = 0; dcR = 0
  midL = 0; midR = 0

  paramChanged(name, value) {
    this.p[name] = value
  }

  process(io, block) {
    const dcCoef = Math.exp(-2 * Math.PI * this.p.dc_freq / this.sr)
    const width = this.p.width
    const balance = this.p.balance
    const mix = this.p.mix
    for (let i = block.s0; i < block.s1; i++) {
      const inL = io.src[0][i]
      const inR = io.src[1][i]
      // DC blocker: one-pole highpass
      const hpL = inL - this.dcL
      const hpR = inR - this.dcR
      this.dcL = inL + (this.dcL - inL) * dcCoef
      this.dcR = inR + (this.dcR - inR) * dcCoef
      // M/S stereo width
      const mid = (hpL + hpR) * 0.5
      const side = (hpL - hpR) * 0.5 * width
      let wL = mid + side
      let wR = mid - side
      // Balance
      if (balance > 0) { wL *= (1 - balance); wR *= (1 + balance * 0) }
      else if (balance < 0) { wR *= (1 + balance); wL *= (1 + balance * 0) }
      io.out[0][i] = inL * (1 - mix) + wL * mix
      io.out[1][i] = inR * (1 - mix) + wR * mix
    }
  }
}
