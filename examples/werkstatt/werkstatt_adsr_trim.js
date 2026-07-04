// @werkstatt adsr_trim 1 1
// @label ADSR Trim
// @param attack 0.001 0.001 0.5 exp s
// @param decay 0.05 0.005 2 exp s
// @param sustain 0.7 0 1 linear
// @param release 0.1 0.01 3 exp s
// @param threshold 0.001 0 0.1 linear
// @param mix 1 0 1 linear

class Processor {
  p = {attack: 0.001, decay: 0.05, sustain: 0.7, release: 0.1, threshold: 0.001, mix: 1}
  sr = sampleRate
  env = 0
  envState = "off" // "attack" "decay" "sustain" "release" "off"
  gateOpen = false
  peakHold = 0

  paramChanged(name, value) {
    this.p[name] = value
  }

  process(io, block) {
    const attCoeff = 1 / (this.p.attack * this.sr)
    const decCoeff = 1 / (this.p.decay * this.sr)
    const relCoeff = 1 / (this.p.release * this.sr)
    const sustainLvl = this.p.sustain
    const threshold = this.p.threshold
    const mix = this.p.mix

    for (let i = block.s0; i < block.s1; i++) {
      const inL = io.src[0][i]
      const inR = io.src[1][i]
      const mono = Math.abs((inL + inR) * 0.5)

      // Gate detection: signal above threshold opens gate
      if (mono > threshold) {
        if (!this.gateOpen) {
          this.gateOpen = true
          this.envState = "attack"
        }
        this.peakHold = 0
      } else {
        this.peakHold++
        // Close gate after ~50ms of silence
        if (this.peakHold > this.sr * 0.05 && this.gateOpen) {
          this.gateOpen = false
          this.envState = "release"
        }
      }

      // ADSR state machine
      if (this.envState === "attack") {
        this.env += attCoeff
        if (this.env >= 1) {
          this.env = 1
          this.envState = "decay"
        }
      } else if (this.envState === "decay") {
        this.env -= decCoeff * (1 - sustainLvl)
        if (this.env <= sustainLvl) {
          this.env = sustainLvl
          this.envState = this.gateOpen ? "sustain" : "release"
        }
      } else if (this.envState === "sustain") {
        this.env = sustainLvl
      } else if (this.envState === "release") {
        this.env -= relCoeff
        if (this.env <= 0) {
          this.env = 0
          this.envState = "off"
        }
      }

      // Apply envelope as gain trim
      const gain = this.env * mix + (1 - mix)
      io.out[0][i] = inL * gain
      io.out[1][i] = inR * gain
    }
  }
}
