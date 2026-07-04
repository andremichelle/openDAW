// @werkstatt reverb 1 1
// @label Plate Reverb
// @param decay 0.4 0.1 0.95 linear
// @param predelay 0.02 0 0.2 linear s
// @param damping 0.5 0 1 linear
// @param width 0.8 0 1 linear
// @param mix 0.3 0 1 linear

class Processor {
  p = {decay: 0.4, predelay: 0.02, damping: 0.5, width: 0.8, mix: 0.3}
  sr = sampleRate

  constructor() {
    // Schroeder reverb: 4 comb filters + 2 allpass
    const combMs = [29.7, 37.1, 41.1, 43.7]
    this.combs = combMs.map(ms => {
      const len = Math.floor(this.sr * ms / 1000)
      return {buf: new Float32Array(len), idx: 0, len}
    })
    const apMs = [5.0, 1.7]
    this.allpasses = apMs.map(ms => {
      const len = Math.floor(this.sr * ms / 1000)
      return {buf: new Float32Array(len), idx: 0, len}
    })
    this.pdBuf = new Float32Array(Math.floor(this.sr * 0.2))
    this.pdIdx = 0
    this.dampL = 0; this.dampR = 0
  }

  paramChanged(name, value) {
    this.p[name] = value
  }

  process(io, block) {
    const decay = this.p.decay
    const pdSamp = Math.floor(this.p.predelay * this.sr)
    const damping = this.p.damping
    const width = this.p.width
    const mix = this.p.mix

    for (let i = block.s0; i < block.s1; i++) {
      const dryL = io.src[0][i]
      const dryR = io.src[1][i]
      const dry = (dryL + dryR) * 0.5

      // Predelay
      const pdRead = (this.pdIdx - pdSamp + this.pdBuf.length) % this.pdBuf.length
      const pdOut = this.pdBuf[pdRead]
      this.pdBuf[this.pdIdx] = dry
      this.pdIdx = (this.pdIdx + 1) % this.pdBuf.length

      // Comb filters
      let wet = pdOut
      for (let k = 0; k < this.combs.length; k++) {
        const c = this.combs[k]
        const fb = c.buf[c.idx]
        this.dampL = this.dampL * damping + fb * (1 - damping)
        c.buf[c.idx] = pdOut + this.dampL * decay
        wet += this.dampL
      }

      // Allpass filters
      for (let k = 0; k < this.allpasses.length; k++) {
        const a = this.allpasses[k]
        const delayed = a.buf[a.idx]
        a.buf[a.idx] = wet + delayed * 0.7
        wet = delayed - wet * 0.7
        a.idx = (a.idx + 1) % a.len
      }

      // Stereo width
      const wL = wet * (0.5 + width * 0.5)
      const wR = wet * (0.5 + (1 - width) * 0.5)

      io.out[0][i] = dryL * (1 - mix) + wL * mix
      io.out[1][i] = dryR * (1 - mix) + wR * mix
    }
  }
}
