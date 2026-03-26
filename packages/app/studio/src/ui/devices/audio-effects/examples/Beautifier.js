// ─────────────────────────────────────────────────────────────────────────────
//  BEAUTIFIER — transparent mastering enhancer
// by Chaosmeister - https://github.com/Chaosmeister 
//
//  Signal chain:
//   src → [warmth: harmonic exciter] → [air: high-shelf exciter]
//       → [punch: transient enhancer] → [width: M/S widener]
//       → [output gain] → out
//
//  All stages are additive and signal-reactive — silence in = silence out.
//
//  WARMTH: generates 2nd + 3rd harmonics via a parallel soft-saturation path.
//    The harmonic signal is high-pass filtered to remove low-end muddiness
//    before being blended back in. Sounds like tape or tube warmth.
//
//  AIR: a single-pole high-pass extracts >8kHz content, soft-saturates it
//    to add upper harmonic shimmer, then blends back. Adds sparkle without
//    harshness.
//
//  PUNCH: an envelope follower tracks the signal's attack transients.
//    When the envelope rises faster than it falls, that delta is added back,
//    effectively boosting attack edges. Makes drums, bass, and chords hit harder.
//
//  WIDTH: mid/side processing. M = (L+R)/2, S = (L-R)/2. Gain the side
//    channel upward to widen, then reconstruct L/R. Zero-phase, no comb issues.
// ─────────────────────────────────────────────────────────────────────────────

// @param warmth  0.3   0.0  1.0
// @param air     0.3   0.0  1.0
// @param width   0.3   0.0  1.0
// @param punch   0.3   0.0  1.0
// @param output  1.0   0.5  1.5  linear

class Processor {
    // ── params ────────────────────────────────────────────────────────────────
    warmth = 0.3
    air    = 0.3
    width  = 0.3
    punch  = 0.3
    output = 1.0

    // ── warmth: harmonic generation ───────────────────────────────────────────
    // 1-pole high-pass on the harmonic signal to avoid low-end mud
    // state: HPF on exciter output per channel
    warmHpL = 0.0
    warmHpR = 0.0

    // ── air: high-shelf extractor (1-pole HPF before saturation) ─────────────
    airHpL  = 0.0
    airHpR  = 0.0

    // ── punch: dual-rate envelope follower per channel ────────────────────────
    // Two envelopes: fast attack, slow attack — difference = transient signal
    punchEnvFastL = 0.0
    punchEnvFastR = 0.0
    punchEnvSlowL = 0.0
    punchEnvSlowR = 0.0

    // ── coefficients (computed once, updated on sampleRate change) ───────────
    // These are just numbers; computed in constructor for the given sampleRate.
    // 1-pole HPF: y[n] = α*(y[n-1] + x[n] - x[n-1])
    // α = τ/(τ+T) where τ=1/(2π*fc) and T=1/sampleRate

    warmHpCoef  = 0.0   // HPF at ~300 Hz  (strips mud from harmonics)
    airHpCoef   = 0.0   // HPF at ~6 kHz   (extracts air band)
    warmPrevL   = 0.0   // HPF x[n-1] state
    warmPrevR   = 0.0
    airPrevL    = 0.0
    airPrevR    = 0.0

    // Punch envelope time constants
    punchAttFast = 0.0   // ~1ms
    punchAttSlow = 0.0   // ~30ms
    punchRel     = 0.0   // ~150ms (shared release for both)

    constructor() {
        const T = 1.0 / sampleRate

        // 1-pole HPF coefficient: α = τ/(τ+T), τ=1/(2π*fc)
        const hpCoef = (fc) => {
            const tau = 1.0 / (2.0 * Math.PI * fc)
            return tau / (tau + T)
        }
        this.warmHpCoef = hpCoef(300)
        this.airHpCoef  = hpCoef(6000)

        // Envelope follower: 1-pole IIR, coef = exp(-1/(sampleRate*time))
        const envCoef = (ms) => 1.0 - Math.exp(-1.0 / (sampleRate * ms * 0.001))
        this.punchAttFast = envCoef(1)
        this.punchAttSlow = envCoef(30)
        this.punchRel     = envCoef(150)
    }

    paramChanged(label, value) {
        if (label === 'warmth') this.warmth = value
        if (label === 'air')    this.air    = value
        if (label === 'width')  this.width  = value
        if (label === 'punch')  this.punch  = value
        if (label === 'output') this.output = value
    }

    // ── soft saturation: even + odd harmonics, unity gain near zero ──────────
    // f(x) = x / (1 + |x|)   → 2nd + 3rd order, smooth, no DC for zero input
    _soft(x) {
        return x / (1.0 + (x < 0 ? -x : x))
    }

    // ── 1-pole HPF (direct form 1) ────────────────────────────────────────────
    // Returns filtered value, updates state in-place via returned object trick —
    // but since we can't allocate, we manually inline per channel in process().

    process({ src, out }, { s0, s1 }) {
        const srcL = src[0], srcR = src[1]
        const outL = out[0], outR = out[1]

        // ── block-constant derived values ─────────────────────────────────────
        const doWarmth  = this.warmth > 0.001
        const doAir     = this.air    > 0.001
        const doPunch   = this.punch  > 0.001
        const doWidth   = this.width  > 0.001

        // Warmth: mix amount for harmonic signal (kept subtle by design)
        const warmMix = this.warmth * 0.35
        const warmHp  = this.warmHpCoef

        // Air: mix amount for high-shelf exciter
        const airMix  = this.air * 0.4
        const airHp   = this.airHpCoef

        // Punch: transient signal blend
        const punchMix  = this.punch * 0.6
        const attFast   = this.punchAttFast
        const attSlow   = this.punchAttSlow
        const rel       = this.punchRel

        // Width: convert [0..1] → side gain [1..2.5] keeping loudness stable
        // At width=0: sideGain=1 (unity, original width). At 1: 2.5× side.
        const sideGain  = 1.0 + this.width * 1.5
        // Compensate mid to preserve loudness: more side = slightly less mid
        const midGain   = 1.0 - this.width * 0.12

        const outputGain = this.output

        for (let i = s0; i < s1; i++) {
            let xL = srcL[i]
            let xR = srcR[i]

            // ── WARMTH: parallel harmonic exciter ────────────────────────────
            // Generate harmonics from input via soft saturation.
            // High-pass the harmonic signal at 300Hz before blending —
            // this removes the fundamental and any added DC, leaving only
            // the generated harmonic overtones (2nd, 3rd order = warmth).
            if (doWarmth) {
                const satL = this._soft(xL)
                const satR = this._soft(xR)

                // 1-pole HPF on saturation output: exciter = sat - (sat LPF)
                // y[n] = α*(y[n-1] + x[n] - x[n-1])
                const newPrevL    = satL
                const newPrevR    = satR
                const warmExcL    = warmHp * (this.warmHpL + satL - this.warmPrevL)
                const warmExcR    = warmHp * (this.warmHpR + satR - this.warmPrevR)
                this.warmHpL      = warmExcL
                this.warmHpR      = warmExcR
                this.warmPrevL    = newPrevL
                this.warmPrevR    = newPrevR

                xL += warmExcL * warmMix
                xR += warmExcR * warmMix
            }

            // ── AIR: high-frequency exciter ───────────────────────────────────
            // Extract >6kHz via HPF, soft-saturate to add upper harmonics,
            // blend back. Adds presence/sparkle without harsh eq boost.
            if (doAir) {
                const airExcL = airHp * (this.airHpL + xL - this.airPrevL)
                const airExcR = airHp * (this.airHpR + xR - this.airPrevR)
                this.airHpL   = airExcL
                this.airHpR   = airExcR
                this.airPrevL = xL
                this.airPrevR = xR

                // Saturate the air band: this adds harmonics above 6kHz
                xL += this._soft(airExcL) * airMix
                xR += this._soft(airExcR) * airMix
            }

            // ── PUNCH: transient enhancer ─────────────────────────────────────
            // Two envelope followers track |x| with different attack speeds.
            // Fast tracks near-instantly; slow takes ~30ms to catch up.
            // Their difference peaks during attack transients only.
            // We add this transient peak back into the signal → punchier attack.
            if (doPunch) {
                const absL = xL < 0 ? -xL : xL
                const absR = xR < 0 ? -xR : xR

                // Fast envelope
                const dfL = absL - this.punchEnvFastL
                const dfR = absR - this.punchEnvFastR
                this.punchEnvFastL += dfL > 0 ? dfL * attFast : dfL * rel
                this.punchEnvFastR += dfR > 0 ? dfR * attFast : dfR * rel

                // Slow envelope
                const dsL = absL - this.punchEnvSlowL
                const dsR = absR - this.punchEnvSlowR
                this.punchEnvSlowL += dsL > 0 ? dsL * attSlow : dsL * rel
                this.punchEnvSlowR += dsR > 0 ? dsR * attSlow : dsR * rel

                // Transient signal = fast - slow (only positive = attack moments)
                let transL = this.punchEnvFastL - this.punchEnvSlowL
                let transR = this.punchEnvFastR - this.punchEnvSlowR
                if (transL < 0) transL = 0
                if (transR < 0) transR = 0

                // Apply transient boost with correct sign (follow input polarity)
                xL += (xL < 0 ? -transL : transL) * punchMix
                xR += (xR < 0 ? -transR : transR) * punchMix
            }

            // ── WIDTH: M/S stereo expansion ───────────────────────────────────
            // Pure mid/side matrix — zero latency, zero phase issues.
            // Widening the side channel only; never touches center content.
            if (doWidth) {
                const mid  = (xL + xR) * 0.5
                const side = (xL - xR) * 0.5
                xL = mid * midGain + side * sideGain
                xR = mid * midGain - side * sideGain
            }

            // ── output gain ───────────────────────────────────────────────────
            outL[i] = xL * outputGain
            outR[i] = xR * outputGain
        }
    }
}
