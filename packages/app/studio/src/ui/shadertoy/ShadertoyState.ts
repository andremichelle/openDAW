import {byte, clamp, clampUnit, Lazy, Terminable, unitValue} from "@opendaw/lib-std"
import {gainToDb, PPQN} from "@opendaw/lib-dsp"
import {ShadertoyMIDIOutput} from "@/ui/shadertoy/ShadertoyMIDIOutput"
import {AnimationFrame} from "@opendaw/lib-dom"
import {MidiData} from "@opendaw/lib-midi"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"

export class ShadertoyState {
    @Lazy
    static get(): ShadertoyState {return new ShadertoyState()}

    static initialize(project: Project): Terminable {
        const {engine: {position, sampleRate}, liveStreamReceiver} = project
        const state = this.get()
        return Terminable.many(
            AnimationFrame.add(() => state.setPPQN(position.getValue())),
            ShadertoyMIDIOutput.subscribe(message => MidiData.accept(message, {
                controller: (id: byte, value: unitValue) => state.onMidiCC(id, value),
                noteOn: (note: byte, velocity: byte) => state.onMidiNoteOn(note, velocity),
                noteOff: (note: byte) => state.onMidiNoteOff(note)
            })),
            liveStreamReceiver.subscribeFloats(EngineAddresses.PEAKS, (peaks) => state.setPeaks(peaks)),
            liveStreamReceiver.subscribeFloats(EngineAddresses.SPECTRUM, spectrum => state.setSpectrum(spectrum, sampleRate)),
            liveStreamReceiver.subscribeFloats(EngineAddresses.WAVEFORM, waveform => state.setWaveform(waveform))
        )
    }

    readonly #audioData = new Uint8Array(512 * 2)
    readonly #midiCCData = new Uint8Array(128)
    readonly #midiNoteData = new Uint8Array(128)
    readonly #noteVelocities: Array<Array<number>> = Array.from({length: 128}, () => [])
    readonly #peaks = new Float32Array(4) // [leftPeak, leftRMS, rightPeak, rightRMS]

    #beat = 0.0

    private constructor() {}

    get audioData(): Uint8Array<ArrayBuffer> {return this.#audioData}
    get midiCCData(): Uint8Array<ArrayBuffer> {return this.#midiCCData}
    get midiNoteData(): Uint8Array<ArrayBuffer> {return this.#midiNoteData}
    get noteVelocities(): Array<Array<number>> {return this.#noteVelocities}
    get peaks(): Float32Array<ArrayBuffer> {return this.#peaks}
    get beat(): number {return this.#beat}
    /**
     * Sets the waveform data (row 1 of iChannel0).
     * @param data Up to 512 samples, -1.0 to 1.0 range
     */
    setWaveform(data: Float32Array): void {
        const length = Math.min(data.length, 512)
        for (let i = 0; i < length; i++) {
            this.#audioData[512 + i] = Math.floor(128.0 * (1.0 + clamp(data[i], -1.0, 1.0)))
        }
    }

    /**
     * Sets the spectrum/FFT data (row 1 of iChannel0).
     * @param data 512 in Float32Array
     * @param sampleRate Sample rate in Hz
     */
    setSpectrum(data: Float32Array, sampleRate: number): void {
        const minFreq = 20.0
        const maxFreq = 20000.0
        const nyquist = sampleRate / 2.0
        const numBins = data.length
        const binWidth = nyquist / numBins
        const ratio = maxFreq / minFreq
        for (let i = 0; i < 512; i++) {
            const t = i / 512.0
            const freq = minFreq * Math.pow(ratio, t)
            const bin = freq / binWidth
            const binLow = Math.floor(bin)
            const binHigh = Math.min(binLow + 1, numBins - 1)
            const frac = bin - binLow
            const valueLow = binLow > 0 ? data[binLow] : 0.0
            const valueHigh = data[binHigh]
            const value = valueLow + frac * (valueHigh - valueLow)
            const normalized = (gainToDb(value) + 60.0) / 60.0
            this.#audioData[i] = Math.floor(clampUnit(normalized) * 255.0)
        }
    }

    /**
     * Sets the beat position.
     * @param ppqn Position in PPQN ticks
     */
    setPPQN(ppqn: number): void {
        this.#beat = ppqn / PPQN.Quarter
    }

    /**
     * Sets stereo peak and RMS values.
     * @param peaks Float32Array with [leftPeak, leftRMS, rightPeak, rightRMS]
     */
    setPeaks(peaks: Float32Array): void {
        this.#peaks.set(peaks)
    }

    /**
     * Sets a MIDI CC value.
     * @param cc Controller number (0-127)
     * @param value Normalized value (0.0-1.0)
     */
    onMidiCC(cc: number, value: number): void {
        this.#midiCCData[cc] = Math.floor(value * 255.0)
    }

    /**
     * Handles a MIDI note on event.
     * @param pitch Note pitch (0-127)
     * @param velocity Normalized velocity (0.0-1.0)
     */
    onMidiNoteOn(pitch: number, velocity: number): void {
        this.#noteVelocities[pitch].push(velocity)
        this.#updateNoteData(pitch)
    }

    /**
     * Handles a MIDI note off event.
     * @param pitch Note pitch (0-127)
     */
    onMidiNoteOff(pitch: number): void {
        this.#noteVelocities[pitch].shift()
        this.#updateNoteData(pitch)
    }

    #updateNoteData(pitch: number): void {
        const velocities = this.#noteVelocities[pitch]
        if (velocities.length === 0) {
            this.#midiNoteData[pitch] = 0
        } else {
            const maxVelocity = Math.max(...velocities)
            this.#midiNoteData[pitch] = Math.floor(maxVelocity * 255.0)
        }
    }
}