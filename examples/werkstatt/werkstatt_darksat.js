// @werkstatt darksat 1 1
// @label Dark Saturation
// @param drive 0.3 0 1 linear
// @param bias 0.0 -0.5 0.5 linear
// @param tone 0.5 0 1 linear
// @param mix 0.8 0 1 linear
// @param output -3 -24 6 linear dB

class Processor {
  // State
  p = {drive: 0.3, bias: 0.0, tone: 0.5, mix: 0.8, output: -3}
  dcL = 0; dcR = 0  // DC blocker state
  lpL = 0; lpR = 0  // tone lowpass state
  hpL = 0; hpR = 0  // tone highpass state

  paramChanged(name, value) {
    this.p[name] = value
  }

  // tanh approximation (cheap)
  _tanh(x) {
    if (x > 3) return 1
    if (x < -3) return -1
    return x * (27 + x*x) / (27 + 9*x*x)
  }

  process(io, block) {
    const outGain = Math.pow(10, this.p.output / 20)
    const driveAmt = 1 + this.p.drive * 4
    const toneMix = this.p.tone
    const wetMix = this.p.mix
    const bias = this.p.bias

    for (let i = block.s0; i < block.s1; i++) {
      const inL = io.src[0][i]
      const inR = io.src[1][i]
      // DC blocker: lowpass estimate → subtract from input
      this.dcL = this.dcL * 0.999 + inL * 0.001
      this.dcR = this.dcR * 0.999 + inR * 0.001
      const dcBlockL = inL - this.dcL
      const dcBlockR = inR - this.dcR

      // Bias + drive + tanh saturation on DC-blocked signal
      const satL = this._tanh((dcBlockL + bias) * driveAmt)
      const satR = this._tanh((dcBlockR + bias) * driveAmt)

      // Tone: shelving (lowpass/highpass blend)
      this.lpL = this.lpL * 0.7 + satL * 0.3
      this.lpR = this.lpR * 0.7 + satR * 0.3
      this.hpL = satL - this.lpL
      this.hpR = satR - this.lpR
      const tonedL = this.lpL * (1 - toneMix) + this.hpL * toneMix
      const tonedR = this.lpR * (1 - toneMix) + this.hpR * toneMix

      // Dry/wet + output gain
      io.out[0][i] = (inL * (1 - wetMix) + tonedL * wetMix) * outGain
      io.out[1][i] = (inR * (1 - wetMix) + tonedR * wetMix) * outGain
    }
  }
}
