// @werkstatt shimmer 1 1
// @label Shimmer Delay
// @param time 0.25 0.01 1 exp s
// @param feedback 0.55 0 0.95 linear
// @param pitch 12 -12 24 int
// @param shimmer 0.4 0 1 linear
// @param damping 0.3 0 1 linear
// @param mix 0.35 0 1 linear

class Processor {
  p = {time: 0.25, feedback: 0.55, pitch: 12, shimmer: 0.4, damping: 0.3, mix: 0.35}
  sr = sampleRate
  phase = 0
  pWriteIdx = 0

  constructor() {
    const maxLen = this.sr
    this.buf = new Float32Array(maxLen * 2)
    this.idx = 0
    // Granular pitch shifter buffer
    this.pitchBuf = new Float32Array(4096)
    this.pitchPhase = 0
    this.dampState = [0, 0]
  }

  paramChanged(name, value) {
    this.p[name] = value
  }

  // Simple granular pitch shift
  _pitchShift(sample, semitones) {
    if (semitones === 0) return sample
    const ratio = Math.pow(2, semitones / 12)
    this.pitchBuf[this.pWriteIdx] = sample
    this.pWriteIdx = (this.pWriteIdx + 1) % this.pitchBuf.length

    this.pitchPhase += ratio
    if (this.pitchPhase >= this.pitchBuf.length) this.pitchPhase -= this.pitchBuf.length

    const ri = Math.floor(this.pitchPhase)
    const ni = (ri + 1) % this.pitchBuf.length
    const f = this.pitchPhase - ri
    return this.pitchBuf[ri] * (1 - f) + this.pitchBuf[ni] * f
  }

  process(io, block) {
    const delaySamp = Math.floor(this.p.time * this.sr)
    const feedback = this.p.feedback
    const semitones = this.p.pitch
    const shimmerAmt = this.p.shimmer
    const damping = this.p.damping
    const mix = this.p.mix
    const maxLen = this.sr

    for (let i = block.s0; i < block.s1; i++) {
      for (let c = 0; c < 2; c++) {
        const bufBase = c * maxLen
        const dry = io.src[c][i]

        // Read delayed
        const readIdx = (this.idx - delaySamp + maxLen) % maxLen
        const delayed = this.buf[bufBase + readIdx]

        // Pitch shift the delayed signal
        const pitched = this._pitchShift(delayed, semitones)

        // Mix dry delay + pitched shimmer
        const wet = delayed * (1 - shimmerAmt) + pitched * shimmerAmt

        // Damping (one-pole lowpass in feedback path)
        this.dampState[c] = this.dampState[c] * damping + wet * (1 - damping)

        // Write with feedback
        this.buf[bufBase + this.idx] = dry + this.dampState[c] * feedback

        io.out[c][i] = dry * (1 - mix) + wet * mix
      }
      this.idx = (this.idx + 1) % maxLen
    }
  }
}
