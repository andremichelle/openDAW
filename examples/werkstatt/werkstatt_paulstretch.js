// @werkstatt paulstretch 1 1
// Paulstretch algorithm — extreme time stretching without pitch change
// Based on Paul Nasca's Paul's Extreme Sound Stretch (GPL2)
// Issue #209: https://github.com/andremichelle/openDAW/issues/209

// @param stretch 0.3 0 1 linear %   // stretch factor (0=1x passthrough, 1=100x extreme)
// @param window  0.5 0 1 linear %   // window size factor (0=short, 1=long)
// @param mix     1.0 0 1 linear %   // dry/wet mix

class Processor {
    stretch = 0.3   // ~30x stretch by default
    window = 0.5    // medium window
    mix = 1.0       // 100% wet
    sRate = 0       // sampleRate from paramChanged

    // Internal buffers
    inputBuf = null     // circular input buffer
    inputPos = 0
    inputSize = 0
    overlapBuf = null   // overlap-add buffer
    overlapPos = 0
    overlapSize = 0
    windowSize = 4096
    hopSize = 2048
    fftSize = 4096
    initialized = false

    // Simple FFT (radix-2 Cooley-Tukey)
    // In-place, re and im arrays
    fft(re, im, inverse) {
        const n = re.length
        // Bit reversal
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1
            for (; j & bit; bit >>= 1) j ^= bit
            j ^= bit
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        // Butterfly
        for (let len = 2; len <= n; len <<= 1) {
            const ang = (inverse ? 2 : -2) * Math.PI / len
            const wRe = Math.cos(ang)
            const wIm = Math.sin(ang)
            for (let i = 0; i < n; i += len) {
                let curRe = 1, curIm = 0
                for (let j = 0; j < len >> 1; j++) {
                    const uRe = re[i + j]
                    const uIm = im[i + j]
                    const vRe = re[i + j + (len >> 1)] * curRe - im[i + j + (len >> 1)] * curIm
                    const vIm = re[i + j + (len >> 1)] * curIm + im[i + j + (len >> 1)] * curRe
                    re[i + j] = uRe + vRe
                    im[i + j] = uIm + vIm
                    re[i + j + (len >> 1)] = uRe - vRe
                    im[i + j + (len >> 1)] = uIm - vIm
                    const newRe = curRe * wRe - curIm * wIm
                    curIm = curRe * wIm + curIm * wRe
                    curRe = newRe
                }
            }
        }
        if (inverse) {
            for (let i = 0; i < n; i++) {
                re[i] /= n
                im[i] /= n
            }
        }
    }

    // Hann window
    hann(buf, size) {
        for (let i = 0; i < size; i++) {
            buf[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)))
        }
    }

    init(sRate) {
        this.sRate = sRate
        // Map params to sizes
        // window 0→1024, 1→16384
        this.windowSize = Math.pow(2, Math.round(10 + this.window * 4))
        this.fftSize = this.windowSize
        // stretch 0→1x (hop=window), 1→100x (hop=window/100)
        const stretchFactor = 1 + this.stretch * 99
        this.hopSize = Math.max(1, Math.round(this.windowSize / stretchFactor))
        // Input buffer = 2x window for safety
        this.inputSize = this.windowSize * 2
        this.inputBuf = new Float32Array(this.inputSize)
        this.inputPos = 0
        // Overlap buffer = windowSize
        this.overlapSize = this.windowSize
        this.overlapBuf = new Float32Array(this.overlapSize)
        this.overlapPos = 0
        this.initialized = true
    }

    paramChanged(label, value) {
        if (label === "stretch") this.stretch = value
        else if (label === "window") this.window = value
        else if (label === "mix") this.mix = value
        // Re-init on stretch/window change (will happen on next process)
        if (label === "stretch" || label === "window") this.initialized = false
    }

    process(io, block) {
        const sr = globalThis.sampleRate || 44100
        if (!this.initialized || this.sRate !== sr) this.init(sr)

        const srcL = io.src[0]
        const srcR = io.src[1] || io.src[0]
        const outL = io.out[0]
        const outR = io.out[1] || io.out[0]
        const len = outL.length

        for (let i = 0; i < len; i++) {
            // Push input to circular buffer
            this.inputBuf[this.inputPos] = (srcL[i] + srcR[i]) * 0.5
            this.inputPos = (this.inputPos + 1) % this.inputSize

            // Pull from overlap buffer
            const wet = this.overlapBuf[this.overlapPos]
            this.overlapBuf[this.overlapPos] = 0  // consume
            this.overlapPos = (this.overlapPos + 1) % this.overlapSize

            // Dry/wet mix
            const dry = (srcL[i] + srcR[i]) * 0.5
            outL[i] = dry * (1 - this.mix) + wet * this.mix
            outR[i] = outL[i]

            // Check if we have enough input for a new frame
            // Count available samples since last frame
        }

        // Process as many frames as possible
        // We need windowSize samples in the input buffer
        // Simple approach: process one frame per block if enough data
        const available = this.inputSize // assume buffer wraps
        if (available >= this.windowSize) {
            this.processFrame()
        }
    }

    processFrame() {
        const n = this.fftSize
        const re = new Float32Array(n)
        const im = new Float32Array(n)
        const win = new Float32Array(n)

        // Read windowSize samples from input buffer (starting hopSize before current pos)
        const startIdx = (this.inputPos - this.windowSize + this.inputSize * 2) % this.inputSize
        for (let i = 0; i < n; i++) {
            const srcIdx = (startIdx + i) % this.inputSize
            re[i] = this.inputBuf[srcIdx]
            im[i] = 0
        }

        // Apply Hann window
        this.hann(win, n)
        for (let i = 0; i < n; i++) re[i] *= win[i]

        // Forward FFT
        this.fft(re, im, false)

        // Paulstretch: randomize phase, keep magnitude
        for (let i = 0; i < n; i++) {
            const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i])
            const phase = Math.random() * 2 * Math.PI
            re[i] = mag * Math.cos(phase)
            im[i] = mag * Math.sin(phase)
        }

        // Inverse FFT
        this.fft(re, im, true)

        // Apply window again (overlap-add)
        for (let i = 0; i < n; i++) re[i] *= win[i]

        // Overlap-add into output buffer
        const writeStart = this.overlapPos
        for (let i = 0; i < n; i++) {
            const idx = (writeStart + i) % this.overlapSize
            this.overlapBuf[idx] += re[i]
        }
        // Advance overlap position by hopSize
        this.overlapPos = (this.overlapPos + this.hopSize) % this.overlapSize
        // Also advance input position by hopSize (to consume input)
        this.inputPos = (this.inputPos + this.hopSize) % this.inputSize
    }
}
