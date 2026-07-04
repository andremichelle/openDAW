// @werkstatt pitch_shift 1 1
// @label Pitch Shifter
// @param semitones 0 -24 24 linear st
// @param cents 0 -50 50 linear ct
// @param latency 0.04 0.01 0.2 exp s
// @param mix 1 0 1 linear

class Processor {
  p = {semitones: 0, cents: 0, latency: 0.04, mix: 1}
  sr = sampleRate
  writePos = 0
  phaseA = 0
  phaseB = 0.5

  constructor() {
    this.bufSize = Math.ceil(this.sr * 0.5)
    this.bufL = new Float32Array(this.bufSize)
    this.bufR = new Float32Array(this.bufSize)
  }

  paramChanged(name, value) {
    this.p[name] = value
  }

  _read(buf, pos) {
    const w = ((pos % this.bufSize) + this.bufSize) % this.bufSize
    const i0 = Math.floor(w)
    const i1 = (i0 + 1) % this.bufSize
    const frac = w - i0
    return buf[i0] * (1 - frac) + buf[i1] * frac
  }

  process(io, block) {
    const sr = this.sr
    const totalShift = this.p.semitones + this.p.cents / 100
    const ratio = Math.pow(2, totalShift / 12)
    const pitchDown = ratio < 1
    const sweepRange = Math.max(1, Math.floor(this.p.latency * sr))
    const mix = this.p.mix
    const inc = Math.abs(ratio - 1) / sweepRange

    for (let i = block.s0; i < block.s1; i++) {
      const inL = io.src[0][i]
      const inR = io.src[1][i]

      this.bufL[this.writePos] = inL
      this.bufR[this.writePos] = inR

      // Linear delay sweep — pitch down: delay grows; pitch up: delay shrinks
      const delayA = pitchDown ? this.phaseA * sweepRange : (1 - this.phaseA) * sweepRange
      const delayB = pitchDown ? this.phaseB * sweepRange : (1 - this.phaseB) * sweepRange

      const readPosA = this.writePos - delayA
      const readPosB = this.writePos - delayB

      // Complementary raised-cosine crossfade (sum ≡ 1)
      const winA = 0.5 * (1 - Math.cos(2 * Math.PI * this.phaseA))
      const winB = 0.5 * (1 - Math.cos(2 * Math.PI * this.phaseB))

      const outL = this._read(this.bufL, readPosA) * winA + this._read(this.bufL, readPosB) * winB
      const outR = this._read(this.bufR, readPosA) * winA + this._read(this.bufR, readPosB) * winB

      io.out[0][i] = inL * (1 - mix) + outL * mix
      io.out[1][i] = inR * (1 - mix) + outR * mix

      this.phaseA += inc
      this.phaseB += inc
      if (this.phaseA >= 1) this.phaseA -= 1
      if (this.phaseB >= 1) this.phaseB -= 1

      this.writePos = (this.writePos + 1) % this.bufSize
    }
  }
}
