// @werkstatt chorus 1 1
// @label Stereo Chorus
// @param rate 0.5 0.05 5 exp Hz
// @param depth 0.3 0 1 linear
// @param center 0.015 0.001 0.05 linear s
// @param feedback 0.2 0 0.9 linear
// @param mix 0.5 0 1 linear

class Processor {
  p = {rate: 0.5, depth: 0.3, center: 0.015, feedback: 0.2, mix: 0.5}
  sr = sampleRate
  phase = 0

  constructor() {
    this.maxDelay = Math.floor(this.sr * 0.05)
    this.bufL = new Float32Array(this.maxDelay)
    this.bufR = new Float32Array(this.maxDelay)
    this.idxL = 0
    this.idxR = 0
  }

  paramChanged(name, value) {
    this.p[name] = value
  }

  process(io, block) {
    const rate = this.p.rate
    const depth = this.p.depth
    const center = this.p.center * this.sr
    const feedback = this.p.feedback
    const mix = this.p.mix

    for (let i = block.s0; i < block.s1; i++) {
      this.phase += 2 * Math.PI * rate / this.sr
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI

      // Two LFOs 90° apart
      const lfoL = Math.sin(this.phase)
      const lfoR = Math.sin(this.phase + Math.PI / 2)

      const delayL = center + depth * center * lfoL
      const delayR = center + depth * center * lfoR

      // Fractional delay read (linear interp)
      const readL = this.idxL - delayL + this.maxDelay
      const readR = this.idxR - delayR + this.maxDelay
      const iL0 = Math.floor(readL) % this.maxDelay
      const iL1 = (iL0 + 1) % this.maxDelay
      const fL = readL - Math.floor(readL)
      const delayedL = this.bufL[iL0] * (1 - fL) + this.bufL[iL1] * fL
      const iR0 = Math.floor(readR) % this.maxDelay
      const iR1 = (iR0 + 1) % this.maxDelay
      const fR = readR - Math.floor(readR)
      const delayedR = this.bufR[iR0] * (1 - fR) + this.bufR[iR1] * fR

      const dryL = io.src[0][i]
      const dryR = io.src[1][i]

      // Write with feedback
      this.bufL[this.idxL] = dryL + delayedL * feedback
      this.bufR[this.idxR] = dryR + delayedR * feedback
      this.idxL = (this.idxL + 1) % this.maxDelay
      this.idxR = (this.idxR + 1) % this.maxDelay

      io.out[0][i] = dryL * (1 - mix) + delayedL * mix
      io.out[1][i] = dryR * (1 - mix) + delayedR * mix
    }
  }
}
