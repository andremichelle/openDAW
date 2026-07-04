// @werkstatt paulstretch 1 1
// Paulstretch algorithm — extreme time stretching without pitch change
// Based on Paul Nasca's Paul's Extreme Sound Stretch (GPL2)
// Issue #209: https://github.com/andremichelle/openDAW/issues/209

// @param stretch 0.3 0 1 linear %   // stretch factor (0=1x passthrough, 1=100x extreme)
// @param window  0.5 0 1 linear %   // window size factor (0=short, 1=long)
// @param mix     1.0 0 1 linear %   // dry/wet mix

class Processor {
    stretch = 0.3
    window = 0.5
    mix = 1.0
    sRate = 0

    inputBuf = null
    inputWritePos = 0
    inputSize = 0
    samplesAccumulated = 0

    overlapBuf = null
    overlapReadPos = 0
    overlapSize = 0

    windowSize = 4096
    hopSize = 2048
    fftSize = 4096
    initialized = false

    fft(re, im, inverse) {
        const n = re.length
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1
            for (; j & bit; bit >>= 1) j ^= bit
            j ^= bit
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
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

    hann(buf, size) {
        for (let i = 0; i < size; i++) {
            buf[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)))
        }
    }

    init(sRate) {
        this.sRate = sRate
        this.windowSize = Math.pow(2, Math.round(10 + this.window * 4))
        this.fftSize = this.windowSize
        const stretchFactor = 1 + this.stretch * 99
        this.hopSize = Math.max(1, Math.round(this.windowSize / stretchFactor))
        this.inputSize = this.windowSize * 2
        this.inputBuf = new Float32Array(this.inputSize)
        this.inputWritePos = 0
        this.samplesAccumulated = 0
        this.overlapSize = this.windowSize
        this.overlapBuf = new Float32Array(this.overlapSize)
        this.overlapReadPos = 0
        this.initialized = true
    }

    paramChanged(label, value) {
        if (label === "stretch") this.stretch = value
        else if (label === "window") this.window = value
        else if (label === "mix") this.mix = value
        if (label === "stretch" || label === "window") this.initialized = false
    }

    process(io, block) {
        const sr = globalThis.sampleRate || 44100
        if (!this.initialized || this.sRate !== sr) this.init(sr)

        const srcL = io.src[0]
        const srcR = io.src[1] || io.src[0]
        const outL = io.out[0]
        const outR = io.out[1] || io.out[0]
        const len = block.s1 - block.s0

        for (let i = 0; i < len; i++) {
            const idx = block.s0 + i
            // Write input to circular buffer (write cursor only)
            this.inputBuf[this.inputWritePos] = (srcL[idx] + srcR[idx]) * 0.5
            this.inputWritePos = (this.inputWritePos + 1) % this.inputSize
            this.samplesAccumulated++

            // Read from overlap buffer (read cursor — independent of input)
            const wet = this.overlapBuf[this.overlapReadPos]
            this.overlapBuf[this.overlapReadPos] = 0
            this.overlapReadPos = (this.overlapReadPos + 1) % this.overlapSize

            const dry = (srcL[idx] + srcR[idx]) * 0.5
            outL[idx] = dry * (1 - this.mix) + wet * this.mix
            if (outR !== outL) outR[idx] = outL[idx]

            // Emit frames when enough samples accumulated (synthesis cursor)
            while (this.samplesAccumulated >= this.hopSize) {
                this.processFrame()
                this.samplesAccumulated -= this.hopSize
            }
        }
    }

    processFrame() {
        const n = this.fftSize
        const re = new Float32Array(n)
        const im = new Float32Array(n)
        const win = new Float32Array(n)

        // Read windowSize samples ending at current write position
        const startIdx = (this.inputWritePos - this.windowSize + this.inputSize * 2) % this.inputSize
        for (let i = 0; i < n; i++) {
            const srcIdx = (startIdx + i) % this.inputSize
            re[i] = this.inputBuf[srcIdx]
            im[i] = 0
        }

        this.hann(win, n)
        for (let i = 0; i < n; i++) re[i] *= win[i]

        this.fft(re, im, false)

        for (let i = 0; i < n; i++) {
            const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i])
            const phase = Math.random() * 2 * Math.PI
            re[i] = mag * Math.cos(phase)
            im[i] = mag * Math.sin(phase)
        }

        this.fft(re, im, true)

        for (let i = 0; i < n; i++) re[i] *= win[i]

        // Overlap-add into output buffer at current read position
        const writeStart = this.overlapReadPos
        for (let i = 0; i < n; i++) {
            const idx = (writeStart + i) % this.overlapSize
            this.overlapBuf[idx] += re[i]
        }
    }
}
