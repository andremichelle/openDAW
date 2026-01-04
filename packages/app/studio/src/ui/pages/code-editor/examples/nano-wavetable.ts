import {InaccessibleProperty} from "@opendaw/lib-std"
import {Api} from "@opendaw/studio-scripting"
import {FFT, midiToHz, PPQN} from "@opendaw/lib-dsp"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// PADsynth algorithm by Paul Nasca (ZynAddSubFX)

export {}

class SeededRandom {
    #seed: number
    constructor(seed: number) {this.#seed = seed}
    next(): number {
        this.#seed = (this.#seed * 1664525 + 1013904223) | 0
        return ((this.#seed >>> 0) / 4294967296)
    }
}

const WAVETABLE_SIZE = 1 << 18
const BASE_FREQ = midiToHz(60, 440.0)
const NUM_HARMONICS = 128
const BANDWIDTH = 80.0
const BW_SCALE = 1.6

const fft = new FFT(WAVETABLE_SIZE)
const real = new Float32Array(WAVETABLE_SIZE)
const imag = new Float32Array(WAVETABLE_SIZE)
const random = new SeededRandom(42)

function profile(fi: number, bwi: number): number {
    const x = fi / bwi
    return Math.exp(-x * x) / bwi
}

for (let nh = 1; nh <= NUM_HARMONICS; nh++) {
    let amp = 1.0 / Math.pow(nh, 0.7)

    amp *= 1.0 + 1.5 * Math.exp(-Math.pow((nh - 6) / 4, 2))
    amp *= 1.0 + 0.8 * Math.exp(-Math.pow((nh - 15) / 6, 2))

    const bw_Hz = (Math.pow(2.0, BANDWIDTH / 1200.0) - 1.0) * BASE_FREQ * Math.pow(nh, BW_SCALE)
    const bwi = bw_Hz / (2.0 * sampleRate)

    const harmonic_freq = BASE_FREQ * nh
    const center_bin = harmonic_freq / sampleRate * WAVETABLE_SIZE
    const bin_range = Math.ceil(bwi * WAVETABLE_SIZE * 5.0)

    for (let i = -bin_range; i <= bin_range; i++) {
        const bin = Math.round(center_bin) + i
        if (bin < 1 || bin >= WAVETABLE_SIZE / 2) continue

        const freq_bin = bin / WAVETABLE_SIZE
        const profile_val = profile(freq_bin - harmonic_freq / sampleRate, bwi)
        const phase = random.next() * 2.0 * Math.PI
        const contribution = amp * profile_val

        real[bin] += contribution * Math.cos(phase)
        imag[bin] += contribution * Math.sin(phase)

        real[WAVETABLE_SIZE - bin] = real[bin]
        imag[WAVETABLE_SIZE - bin] = -imag[bin]
    }
}

for (let i = 0; i < WAVETABLE_SIZE; i++) {
    imag[i] = -imag[i]
}

fft.process(real, imag)

const scale = 1.0 / WAVETABLE_SIZE
for (let i = 0; i < WAVETABLE_SIZE; i++) {
    real[i] *= scale
    imag[i] *= -scale
}

let max = 0
for (let i = 0; i < WAVETABLE_SIZE; i++) {
    const abs = Math.abs(real[i])
    if (abs > max) max = abs
}

const gain = 0.7 / max
const framesLeft = new Float32Array(WAVETABLE_SIZE)
const framesRight = new Float32Array(WAVETABLE_SIZE)

for (let i = 0; i < WAVETABLE_SIZE; i++) {
    framesLeft[i] = real[i] * gain
    framesRight[i] = real[(i + WAVETABLE_SIZE / 2) % WAVETABLE_SIZE] * gain
}

const sample = await openDAW.addSample({
    frames: [framesLeft, framesRight],
    numberOfFrames: WAVETABLE_SIZE,
    numberOfChannels: 2,
    sampleRate
}, "Lush Chorus Pad")

const project = openDAW.newProject("Time")
project.bpm = 80

const nanoUnit = project.addInstrumentUnit("Nano", x => x.sample = sample)
nanoUnit.volume = -6
nanoUnit.addAudioEffect("delay", {
    delay: 4,
    feedback: 0.75,
    cross: 1.0,
    wet: -3.0,
    dry: 0.0
})

const noteTrack = nanoUnit.addNoteTrack()
const region = noteTrack.addRegion({
    position: 0,
    duration: PPQN.Bar * 4
})

const chords = [
    [36, 48, 55, 60, 67],
    [33, 45, 52, 57, 64],
    [38, 50, 57, 62, 69],
    [41, 53, 60, 65, 72]
]

const events = []
for (let bar = 0; bar < 4; bar++) {
    for (let note of chords[bar]) {
        events.push({
            position: PPQN.Bar * bar,
            pitch: note,
            velocity: 0.7,
            duration: PPQN.Bar
        })
    }
}

region.addEvents(events)
project.openInStudio()