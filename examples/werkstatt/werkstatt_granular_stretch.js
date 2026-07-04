// @werkstatt granular_stretch 1 1
// @label Granular Time-Stretch
// @param stretch 2 0.5 20 exp
// @param grain 0.08 0.02 0.5 linear s
// @param overlap 0.5 0 0.9 linear
// @param pitch 0 -12 12 int
// @param mix 1 0 1 linear

class Processor {
  p = {stretch: 2, grain: 0.08, overlap: 0.5, pitch: 0, mix: 1}
  sr = sampleRate
  writePos = 0
  readPos = 0
  grainPhase = 0
  grainLen = 0
  windowPos = 0

  constructor() {
    this.bufSize = this.sr * 4 // 4 second buffer
    this.bufL = new Float32Array(this.bufSize)
    this.bufR = new Float32Array(this.bufSize)
    this._updateGrain()
  }

  _updateGrain() {
    this.grainLen = Math.floor(this.p.grain * this.sr)
  }

  paramChanged(name, value) {
    this.p[name] = value
    if (name === "grain") this._updateGrain()
  }

  // Hann window
  _hann(t) {
    return 0.5 * (1 - Math.cos(2 * Math.PI * t))
  }

  process(io, block) {
    const stretch = this.p.stretch
    const overlap = this.p.overlap
    const semitones = this.p.pitch
    const mix = this.p.mix
    const pitchRatio = Math.pow(2, semitones / 12)
    const hopSize = Math.floor(this.grainLen * (1 - overlap))
    const readInc = 1 / stretch

    for (let i = block.s0; i < block.s1; i++) {
      const inL = io.src[0][i]
      const inR = io.src[1][i]

      // Write to buffer
      this.bufL[this.writePos] = inL
      this.bufR[this.writePos] = inR
      this.writePos = (this.writePos + 1) % this.bufSize

      // Granular read: two overlapping grains
      let outL = 0
      let outR = 0

      for (let g = 0; g < 2; g++) {
        const grainOffset = g * hopSize
        const localRead = Math.floor(this.readPos - grainOffset + this.bufSize) % this.bufSize
        const windowIdx = (this.grainPhase + g * hopSize) % this.grainLen
        const windowT = windowIdx / this.grainLen

        if (windowT >= 0 && windowT < 1) {
          const win = this._hann(windowT)
          const readIdx = Math.floor(localRead * pitchRatio) % this.bufSize
          outL += this.bufL[readIdx] * win
          outR += this.bufR[readIdx] * win
        }
      }

      // Normalize for overlap count
      outL *= 0.5
      outR *= 0.5

      // Advance read position
      this.grainPhase += readInc
      if (this.grainPhase >= this.grainLen) {
        this.grainPhase -= this.grainLen
        this.readPos = (this.readPos + hopSize) % this.bufSize
      }

      io.out[0][i] = inL * (1 - mix) + outL * mix
      io.out[1][i] = inR * (1 - mix) + outR * mix
    }
  }
}
