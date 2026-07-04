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
    // Schroeder reverb: 4 comb filters + 2 allpass per channel
    // Slightly different delay times L vs R for stereo decorrelation
    const combMsL = [29.7, 37.1, 41.1, 43.7]
    const combMsR = [30.1, 36.5, 41.7, 43.3]
    const apMsL = [5.0, 1.7]
    const apMsR = [4.8, 1.9]

    this.combsL = combMsL.map(ms => this._mkComb(this.sr * ms / 1000))
    this.combsR = combMsR.map(ms => this._mkComb(this.sr * ms / 1000))
    this.apsL = apMsL.map(ms => this._mkAp(this.sr * ms / 1000))
    this.apsR = apMsR.map(ms => this._mkAp(this.sr * ms / 1000))

    this.pdBufL = new Float32Array(Math.floor(this.sr * 0.2))
    this.pdBufR = new Float32Array(Math.floor(this.sr * 0.2))
    this.pdIdx = 0
  }

  _mkComb(len) {
    const n = Math.floor(len)
    return {buf: new Float32Array(n), idx: 0, len: n, damp: 0}
  }

  _mkAp(len) {
    const n = Math.floor(len)
    return {buf: new Float32Array(n), idx: 0, len: n}
  }

  paramChanged(name, value) {
    this.p[name] = value
  }

  _combProcess(c, input, decay, damping) {
    const fb = c.buf[c.idx]
    c.damp = c.damp * damping + fb * (1 - damping)
    c.buf[c.idx] = input + c.damp * decay
    c.idx = (c.idx + 1) % c.len
    return c.damp
  }

  _apProcess(a, input) {
    const delayed = a.buf[a.idx]
    a.buf[a.idx] = input + delayed * 0.7
    a.idx = (a.idx + 1) % a.len
    return delayed - input * 0.7
  }

  process(io, block) {
    const decay = this.p.decay
    const pdSamp = Math.floor(this.p.predelay * this.sr)
    const damping = this.p.damping
    const width = this.p.width
    const mix = this.p.mix
    const pdLen = this.pdBufL.length

    for (let i = block.s0; i < block.s1; i++) {
      const dryL = io.src[0][i]
      const dryR = io.src[1][i]

      // Predelay (per-channel)
      const pdReadL = (this.pdIdx - pdSamp + pdLen) % pdLen
      const pdReadR = (this.pdIdx - pdSamp + pdLen) % pdLen
      const pdOutL = this.pdBufL[pdReadL]
      const pdOutR = this.pdBufR[pdReadR]
      this.pdBufL[this.pdIdx] = dryL
      this.pdBufR[this.pdIdx] = dryR
      this.pdIdx = (this.pdIdx + 1) % pdLen

      // Comb bank L
      let wetL = pdOutL
      for (let k = 0; k < this.combsL.length; k++) {
        wetL += this._combProcess(this.combsL[k], pdOutL, decay, damping)
      }

      // Comb bank R
      let wetR = pdOutR
      for (let k = 0; k < this.combsR.length; k++) {
        wetR += this._combProcess(this.combsR[k], pdOutR, decay, damping)
      }

      // Allpass L
      for (let k = 0; k < this.apsL.length; k++) {
        wetL = this._apProcess(this.apsL[k], wetL)
      }

      // Allpass R
      for (let k = 0; k < this.apsR.length; k++) {
        wetR = this._apProcess(this.apsR[k], wetR)
      }

      // M/S width control: width=0 → mono, width=1 → full stereo
      const mid = (wetL + wetR) * 0.5
      const side = (wetL - wetR) * 0.5 * width
      const wL = mid + side
      const wR = mid - side

      io.out[0][i] = dryL * (1 - mix) + wL * mix
      io.out[1][i] = dryR * (1 - mix) + wR * mix
    }
  }
}
