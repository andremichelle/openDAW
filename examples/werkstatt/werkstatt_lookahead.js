// @werkstatt lookahead 1 1
// @label Lookahead Compressor
// @param threshold -18 -60 0 linear dB
// @param ratio 4 1 20 linear
// @param attack 0.003 0.001 0.1 exp s
// @param release 0.25 0.01 2 exp s
// @param knee 6 0 12 linear dB
// @param makeup 0 0 24 linear dB
// @param mix 1 0 1 linear

class Processor {
  p = {threshold: -18, ratio: 4, attack: 0.003, release: 0.25, knee: 6, makeup: 0, mix: 1}
  sr = sampleRate
  env = 0

  constructor() {
    const laLen = Math.floor(this.sr * 0.01)
    this.lookBuf = new Float32Array(laLen)
    this.lookIdx = 0
  }

  paramChanged(name, value) {
    this.p[name] = value
  }

  process(io, block) {
    const threshold = this.p.threshold
    const ratio = this.p.ratio
    const attackCoef = Math.exp(-1 / (this.p.attack * this.sr))
    const releaseCoef = Math.exp(-1 / (this.p.release * this.sr))
    const knee = this.p.knee
    const makeupLin = Math.pow(10, this.p.makeup / 20)
    const mix = this.p.mix

    for (let i = block.s0; i < block.s1; i++) {
      const inL = io.src[0][i]
      const inR = io.src[1][i]
      const mono = (inL + inR) * 0.5

      // Lookahead: store current, read delayed
      const delayed = this.lookBuf[this.lookIdx]
      this.lookBuf[this.lookIdx] = mono
      this.lookIdx = (this.lookIdx + 1) % this.lookBuf.length

      // Envelope follower (peak)
      const absIn = Math.abs(mono)
      const coef = absIn > this.env ? attackCoef : releaseCoef
      this.env = absIn + (this.env - absIn) * coef

      // Gain reduction (dB domain, soft knee)
      const envDb = 20 * Math.log10(this.env + 1e-10)
      let gr = 0
      const kneeStart = threshold - knee * 0.5
      const kneeEnd = threshold + knee * 0.5

      if (envDb > kneeEnd) {
        gr = (envDb - threshold) * (1 - 1 / ratio)
      } else if (envDb > kneeStart) {
        const x = envDb - kneeStart
        gr = (1 - 1 / ratio) * (x * x) / (2 * knee)
      }

      const gainLin = Math.pow(10, -gr / 20) * makeupLin
      const outGain = gainLin * mix + (1 - mix)

      io.out[0][i] = inL * outGain
      io.out[1][i] = inR * outGain
    }
  }
}
