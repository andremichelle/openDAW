// Alienator
// by Chaosmeister - https://github.com/Chaosmeister
// @param chaos    0.3   0.0   1.0
// @param drift    0.0   0.0   1.0
// @param fold     0.5   0.0   1.0
// @param crush    16.0   1.0   16.0 int Bits
// @param decimate 0.0   0.0   1.0 linear %
// @param release  1.0   0.0   1.0
// @param ring     0.0   0.0   1.0
// @param ringHz   220   10    4000  exp  Hz
// @param dry/wet  0.0   -1.0   1.0

const ALIEN_DELAY = 65536
const ALIEN_MASK = ALIEN_DELAY - 1

class Processor {
    fold = 0.5
    crush = 16.0
    decimate = 0.0
    ring = 0.0
    ringHz = 220
    chaos = 0.3
    drift = 1.0
    release = 1.0
    wet = 0.0

    ringPhL = 0.0
    ringPhR = 0.0
    TWO_PI = Math.PI * 2

    decimHoldL = 0.0
    decimHoldR = 0.0
    decimCntL = 0
    decimCntR = 0

    delayL = new Float32Array(ALIEN_DELAY)
    delayR = new Float32Array(ALIEN_DELAY)
    delayWr = 0

    paramChanged(label, value) {
        if (label === 'chaos') this.chaos = value
        if (label === 'drift') this.drift = value
        if (label === 'fold') this.fold = value
        if (label === 'crush') this.crush = value
        if (label === 'decimate') this.decimate = value
        if (label === 'ring') this.ring = value
        if (label === 'ringHz') this.ringHz = value
        if (label === 'release') this.release = value
        if (label === 'dry/wet') this.wet = value
    }

    _fold(x) {
        // Wrap into [-2, 2) using period-4 triangle symmetry
        x = x % 4.0
        // Correct range to [-2, 2) manually (JS % keeps sign of dividend)
        if (x > 2.0) x = x - 4.0
        if (x < -2.0) x = x + 4.0
        // Now reflect the peaks at ±1 back inward
        if (x > 1.0) x = 2.0 - x
        if (x < -1.0) x = -2.0 - x
        return x
    }

    process({ src, out }, { s0, s1, flags }) {
        const srcL = src[0], srcR = src[1]
        const outL = out[0], outR = out[1]

        if (flags & 2) {
            this.ringPhL = 0.0
            this.ringPhR = 0.0
        }

        const ringInc = this.ringHz / sampleRate * this.TWO_PI
        const ringDetune = ringInc * 1.00073
        const foldDrive = 1.0 + this.fold * 18.0
        const hasFold = this.fold > 0.001
        const hasCrush = this.crush != 16
        const hasDecim = this.decimate > 0.001
        const hasRing = this.ring > 0.001
        const chaosAmt = this.chaos
        const wetAmt = Math.min(Math.max(this.wet / 2 + 0.5, 0), 1)
        const dryAmt = Math.abs(Math.min(Math.max(this.wet / 2 - 0.5, -1), 0))

        const bits = this.crush
        const crushLevels = Math.pow(2.0, bits)
        const crushInv = 1.0 / crushLevels

        const decimStep = 1 + Math.floor(this.decimate * 63.0)
        const chaosBase = Math.floor(0.008 * sampleRate)
        const chaosSwing = Math.floor(0.004 * sampleRate)
        const chaosFB = chaosAmt * 0.65

        for (let i = s0; i < s1; i++) {
            let xL = srcL[i]
            let xR = srcR[i]

            const dryL = xL
            const dryR = xR

            // ── STAGE 1: chaos feedback ──────────────────────────────────────
            if (chaosAmt > 0.001) {
                const swing = xL < -1.0 ? -1.0 : xL > 1.0 ? 1.0 : xL
                const offset = chaosBase + Math.floor(swing * chaosSwing)
                const rdL = ((1 - this.drift) * this.delayWr - offset + ALIEN_DELAY) & ALIEN_MASK
                const rdR = ((1 - this.drift) * this.delayWr - offset - 7 + ALIEN_DELAY) & ALIEN_MASK
                xL += this.delayL[rdL] * chaosFB
                xR += this.delayR[rdR] * chaosFB
            }

            // ── STAGE 2: wavefolder ──────────────────────────────────────────
            if (hasFold) {
                xL = this._fold(xL * foldDrive)
                xR = this._fold(xR * foldDrive)
            }

            // ── STAGE 3: bitcrusher ──────────────────────────────────────────
            if (hasCrush) {
                xL = Math.round(xL * crushLevels) * crushInv
                xR = Math.round(xR * crushLevels) * crushInv
            }

            // ── STAGE 4: sample decimator ────────────────────────────────────
            if (hasDecim) {
                if (this.decimCntL <= 0) { this.decimHoldL = xL; this.decimCntL = decimStep }
                if (this.decimCntR <= 0) { this.decimHoldR = xR; this.decimCntR = decimStep }
                this.decimCntL--
                this.decimCntR--
                xL = this.decimHoldL
                xR = this.decimHoldR
            }

            // ── STAGE 5: ring modulation ─────────────────────────────────────
            if (hasRing) {
                const rl = Math.sin(this.ringPhL)
                const rr = Math.sin(this.ringPhR)
                xL = xL * (1.0 - this.ring) + xL * rl * this.ring
                xR = xR * (1.0 - this.ring) + xR * rr * this.ring
            }
            this.ringPhL += ringInc
            if (this.ringPhL > this.TWO_PI) this.ringPhL -= this.TWO_PI
            this.ringPhR += ringDetune
            if (this.ringPhR > this.TWO_PI) this.ringPhR -= this.TWO_PI

            // Write processed signal into delay (after stages, before limiter)
            this.delayL[this.delayWr] = xL * this.release
            this.delayR[this.delayWr] = xR * this.release
            this.delayWr = (this.delayWr + 1) & ALIEN_MASK

            // ── output: tanh limiter + dry/wet ───────────────────────────────
            xL = Math.tanh(xL)
            xR = Math.tanh(xR)

            outL[i] = dryL * dryAmt + xL * wetAmt
            outR[i] = dryR * dryAmt + xR * wetAmt
        }
    }
}
