// @werkstatt coldfold 1 1
// @label Cold Fold Distortion
// @param drive 0.5 0 2 linear
// @param fold 0.3 0 1 linear
// @param crush 0 0 1 linear
// @param slew 0 0 1 linear
// @param mix 0.7 0 1 linear

class Processor {
  p = {drive: 0.5, fold: 0.3, crush: 0, slew: 0, mix: 0.7}
  slewL = 0; slewR = 0
  crushPhase = 0
  crushHoldL = 0; crushHoldR = 0

  paramChanged(name, value) {
    this.p[name] = value
  }

  _fold(x, amount) {
    let y = x * (1 + amount * 3)
    while (y > 1 || y < -1) {
      if (y > 1) y = 2 - y
      else if (y < -1) y = -2 - y
    }
    return y
  }

  process(io, block) {
    const driveAmt = this.p.drive
    const foldAmt = this.p.fold
    const crushAmt = this.p.crush
    const slewAmt = this.p.slew
    const wetMix = this.p.mix

    for (let i = block.s0; i < block.s1; i++) {
      const inL = io.src[0][i]
      const inR = io.src[1][i]

      // Drive
      let dL = inL * (1 + driveAmt)
      let dR = inR * (1 + driveAmt)

      // Wavefold
      dL = this._fold(dL, foldAmt)
      dR = this._fold(dR, foldAmt)

      // Bitcrush (sample-rate reduction)
      if (crushAmt > 0) {
        this.crushPhase += 1
        const holdInterval = Math.max(1, Math.floor(1 + crushAmt * 20))
        if (this.crushPhase >= holdInterval) {
          this.crushPhase = 0
          // Bit depth reduction
          const bits = Math.max(2, Math.floor(16 - crushAmt * 14))
          const step = Math.pow(2, bits)
          this.crushHoldL = Math.round(dL * step) / step
          this.crushHoldR = Math.round(dR * step) / step
        }
        dL = this.crushHoldL
        dR = this.crushHoldR
      }

      // Slew (lowpass on output) — 0=dry, 1=max smoothing
      const slewCoef = 1 - slewAmt
      this.slewL += (dL - this.slewL) * slewCoef
      this.slewR += (dR - this.slewR) * slewCoef
      if (slewAmt > 0) { dL = this.slewL; dR = this.slewR }

      io.out[0][i] = inL * (1 - wetMix) + dL * wetMix
      io.out[1][i] = inR * (1 - wetMix) + dR * wetMix
    }
  }
}
