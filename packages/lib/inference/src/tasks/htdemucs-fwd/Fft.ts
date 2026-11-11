export type FftTwiddles = {readonly cos: Float32Array, readonly sin: Float32Array}

export const buildHannWindow = (size: number): Float32Array => {
    const window = new Float32Array(size)
    for (let i = 0; i < size; i++) {
        window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
    }
    return window
}

export const buildFftTwiddles = (n: number): FftTwiddles => {
    const half = n / 2
    const cos = new Float32Array(half)
    const sin = new Float32Array(half)
    for (let i = 0; i < half; i++) {
        const angle = -2 * Math.PI * i / n
        cos[i] = Math.cos(angle)
        sin[i] = Math.sin(angle)
    }
    return {cos, sin}
}

export const buildBitReverseTable = (n: number): Uint32Array => {
    const table = new Uint32Array(n)
    const bits = Math.log2(n) | 0
    for (let i = 0; i < n; i++) {
        let rev = 0
        let value = i
        for (let b = 0; b < bits; b++) {
            rev = (rev << 1) | (value & 1)
            value >>= 1
        }
        table[i] = rev
    }
    return table
}

export const fftInPlace = (
    real: Float32Array,
    imag: Float32Array,
    n: number,
    twiddles: FftTwiddles,
    bitRev: Uint32Array
): void => {
    for (let i = 0; i < n; i++) {
        const j = bitRev[i]
        if (j > i) {
            const tmpR = real[i]; real[i] = real[j]; real[j] = tmpR
            const tmpI = imag[i]; imag[i] = imag[j]; imag[j] = tmpI
        }
    }
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1
        const step = n / size
        for (let start = 0; start < n; start += size) {
            for (let k = 0; k < half; k++) {
                const tIdx = k * step
                const wR = twiddles.cos[tIdx]
                const wI = twiddles.sin[tIdx]
                const idxEven = start + k
                const idxOdd = start + k + half
                const eR = real[idxEven]
                const eI = imag[idxEven]
                const oR = real[idxOdd]
                const oI = imag[idxOdd]
                const tR = wR * oR - wI * oI
                const tI = wR * oI + wI * oR
                real[idxEven] = eR + tR
                imag[idxEven] = eI + tI
                real[idxOdd] = eR - tR
                imag[idxOdd] = eI - tI
            }
        }
    }
}

export const ifftInPlace = (
    real: Float32Array,
    imag: Float32Array,
    n: number,
    twiddles: FftTwiddles,
    bitRev: Uint32Array
): void => {
    for (let i = 0; i < n; i++) {imag[i] = -imag[i]}
    fftInPlace(real, imag, n, twiddles, bitRev)
    const invN = 1 / n
    for (let i = 0; i < n; i++) {
        real[i] = real[i] * invN
        imag[i] = -imag[i] * invN
    }
}

export const padReflect1d = (signal: Float32Array, padLeft: number, padRight: number): Float32Array => {
    const N = signal.length
    const out = new Float32Array(padLeft + N + padRight)
    out.set(signal, padLeft)
    for (let i = 0; i < padLeft; i++) {
        out[padLeft - 1 - i] = signal[i + 1]
    }
    for (let i = 0; i < padRight; i++) {
        out[padLeft + N + i] = signal[N - 2 - i]
    }
    return out
}
