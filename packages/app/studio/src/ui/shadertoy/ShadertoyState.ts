import {byte, clamp, clampUnit, Terminable, unitValue} from "@moises-ai/lib-std"
import {gainToDb, PPQN} from "@moises-ai/lib-dsp"
import {ShadertoyMIDIOutput} from "@/ui/shadertoy/ShadertoyMIDIOutput"
import {AnimationFrame} from "@moises-ai/lib-dom"
import {MidiData} from "@moises-ai/lib-midi"
import {EngineAddresses} from "@moises-ai/studio-adapters"
import {Project} from "@moises-ai/studio-core"

export class ShadertoyState implements Terminable {
    readonly #terminable: Terminable
    readonly #audioData = new Uint8Array(512 * 2)
    readonly #midiCCData = new Uint8Array(128)
    readonly #midiNoteData = new Uint8Array(128)
    readonly #noteVelocities: Array<Array<number>> = Array.from({length: 128}, () => [])
    readonly #peaks = new Float32Array(4) // [leftPeak, leftRMS, rightPeak, rightRMS]

    #beat = 0.0

    constructor(project: Project) {
        this.#terminable = this.#listen(project)
    }

    get audioData(): Uint8Array<ArrayBuffer> {return this.#audioData}
    get midiCCData(): Uint8Array<ArrayBuffer> {return this.#midiCCData}
    get midiNoteData(): Uint8Array<ArrayBuffer> {return this.#midiNoteData}
    get peaks(): Float32Array<ArrayBuffer> {return this.#peaks}
    get beat(): number {return this.#beat}

    /**
     * Sets the beat position.
     * @param ppqn Position in PPQN ticks
     */
    setPPQN(ppqn: number): void {
        this.#beat = ppqn / PPQN.Quarter
    }

    terminate(): void {this.#terminable.terminate()}

    /**
     * Sets the waveform data (row 1 of iChannel0).
     * @param data Up to 512 samples, -1.0 to 1.0 range
     */
    #setWaveform(data: Float32Array): void {
        const length = Math.min(data.length, 512)
        for (let i = 0; i < length; i++) {
            this.#audioData[512 + i] = Math.round((clamp(data[i], -1.0, 1.0) + 1.0) * 127.5)
        }
    }

    /**
     * Sets the spectrum/FFT data (row 1 of iChannel0).
     * @param data 512 in Float32Array
     * @param sampleRate Sample rate in Hz
     */
    #setSpectrum(data: Float32Array, sampleRate: number): void {
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
     * Sets stereo peak and RMS values.
     * @param peaks Float32Array with [leftPeak, leftRMS, rightPeak, rightRMS]
     */
    #setPeaks(peaks: Float32Array): void {
        this.#peaks.set(peaks)
    }

    /**
     * Sets a MIDI CC value.
     * @param cc Controller number (0-127)
     * @param value Normalized value (0.0-1.0)
     */
    #onMidiCC(cc: number, value: number): void {
        this.#midiCCData[cc] = Math.floor(value * 255.0)
    }

    /**
     * Handles a MIDI note on event.
     * @param pitch Note pitch (0-127)
     * @param velocity Normalized velocity (0.0-1.0)
     */
    #onMidiNoteOn(pitch: number, velocity: number): void {
        this.#noteVelocities[pitch].push(velocity)
        this.#updateNoteData(pitch)
    }

    /**
     * Handles a MIDI note off event.
     * @param pitch Note pitch (0-127)
     */
    #onMidiNoteOff(pitch: number): void {
        this.#noteVelocities[pitch].shift()
        this.#updateNoteData(pitch)
    }

    #listen(project: Project): Terminable {
        const {engine: {position, sampleRate}, liveStreamReceiver} = project
        return Terminable.many(
            AnimationFrame.add(() => this.setPPQN(position.getValue())),
            ShadertoyMIDIOutput.subscribe(message => MidiData.accept(message, {
                controller: (id: byte, value: unitValue) => this.#onMidiCC(id, value),
                noteOn: (note: byte, velocity: byte) => this.#onMidiNoteOn(note, velocity),
                noteOff: (note: byte) => this.#onMidiNoteOff(note)
            })),
            liveStreamReceiver.subscribeFloats(EngineAddresses.PEAKS, (peaks) => this.#setPeaks(peaks)),
            liveStreamReceiver.subscribeFloats(EngineAddresses.SPECTRUM, spectrum => this.#setSpectrum(spectrum, sampleRate)),
            liveStreamReceiver.subscribeFloats(EngineAddresses.WAVEFORM, waveform => this.#setWaveform(waveform))
        )
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