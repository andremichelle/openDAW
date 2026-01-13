import {bipolar, clampUnit, Id, InaccessibleProperty, int, mint, unitValue} from "@moises-ai/lib-std"
import {
    Adsr,
    AudioBuffer,
    BandLimitedOscillator,
    Glide,
    LFO,
    MidiKeys,
    Mixing,
    ModulatedBiquad,
    NoteEvent,
    ppqn,
    RenderQuantum,
    SILENCE_THRESHOLD,
    Smooth,
    StereoMatrix,
    velocityToGain
} from "@moises-ai/lib-dsp"
import {VaporisateurSettings} from "@moises-ai/studio-adapters"
import {VaporisateurDeviceProcessor} from "./VaporisateurDeviceProcessor"
import {Voice} from "../../voicing/Voice"
import {Block} from "../../processing"

// We can do this because there is no multi-threading within the processor
const [
    oscABuffer, oscBBuffer, freqBuffer, freqBufferA, freqBufferB,
    vcaBuffer, lfoBuffer, cutoffBuffer, oscSumBuffer
] = mint(Float32Array, RenderQuantum)

export class VaporisateurVoice implements Voice {
    readonly device: VaporisateurDeviceProcessor
    readonly oscA: BandLimitedOscillator
    readonly oscB: BandLimitedOscillator
    readonly lfo: LFO
    readonly filter: ModulatedBiquad
    readonly env: Adsr
    readonly glide: Glide
    readonly gainASmooth: Smooth
    readonly gainBSmooth: Smooth
    readonly gainVcaSmooth: Smooth

    #event: Id<NoteEvent> = InaccessibleProperty("NoteEvent not set")
    #gain: unitValue = 1.0
    #spread: bipolar = 1.0

    id: int = -1
    phase: number = 0.0
    filter_keyboard_delta: number = 0.0

    constructor(device: VaporisateurDeviceProcessor) {
        this.device = device

        this.oscA = new BandLimitedOscillator(sampleRate)
        this.oscB = new BandLimitedOscillator(sampleRate)
        this.lfo = new LFO(sampleRate)
        this.filter = new ModulatedBiquad(VaporisateurSettings.MIN_CUTOFF, VaporisateurSettings.MAX_CUTOFF, sampleRate)
        this.filter.order = 1
        this.env = new Adsr(sampleRate)
        this.env.set(this.device.env_attack, this.device.env_decay, this.device.env_sustain, this.device.env_release)
        this.env.gateOn()
        this.glide = new Glide()
        this.gainASmooth = new Smooth(0.003, sampleRate)
        this.gainBSmooth = new Smooth(0.003, sampleRate)
        this.gainVcaSmooth = new Smooth(0.003, sampleRate)
    }

    start(event: Id<NoteEvent>, frequency: number, gain: unitValue, spread: bipolar): void {
        this.#event = event
        this.#gain = gain
        this.#spread = spread
        this.filter_keyboard_delta = MidiKeys.keyboardTracking(event.pitch, this.device.parameterFilterKeyboard.getValue())
        this.glide.init(frequency)
    }

    stop(): void {this.env.gateOff()}

    forceStop(): void {this.env.forceStop()}

    startGlide(targetFrequency: number, glideDuration: ppqn): void {
        this.glide.glideTo(targetFrequency, glideDuration)
    }

    get gate(): boolean {return this.env.gate}
    get currentFrequency(): number {return this.glide.currentFrequency()}

    process(output: AudioBuffer, {bpm}: Block, fromIndex: int, toIndex: int): boolean {
        const {
            gainOscA,
            gainOscB,
            oscA_waveform,
            oscB_waveform,
            flt_cutoff,
            flt_resonance,
            flt_env_amount,
            flt_order,
            frequencyAMultiplier,
            frequencyBMultiplier,
            parameterLfoShape,
            parameterLfoRate,
            parameterLfoTargetTune,
            parameterLfoTargetCutoff,
            parameterLfoTargetVolume,
            parameterUnisonDetune,
            parameterUnisonStereo
        } = this.device
        const gain = velocityToGain(this.#event.velocity) * this.#gain
        const detune = 2.0 ** (this.#spread * (parameterUnisonDetune.getValue() / 1200.0))
        const panning = this.#spread * parameterUnisonStereo.getValue()
        const [gainL, gainR] = StereoMatrix.panningToGains(panning, Mixing.Linear)
        const [outL, outR] = output.channels()

        freqBuffer.fill(detune, fromIndex, toIndex)
        this.glide.process(freqBuffer, bpm, fromIndex, toIndex)
        this.lfo.fill(lfoBuffer, parameterLfoShape.getValue(), parameterLfoRate.getValue(), fromIndex, toIndex)
        this.env.process(vcaBuffer, fromIndex, toIndex)

        const lfo_target_tune = parameterLfoTargetTune.getValue()
        const lfo_target_cutoff = parameterLfoTargetCutoff.getValue()
        const lfo_target_volume = parameterLfoTargetVolume.getValue()

        for (let i = fromIndex; i < toIndex; i++) {
            // apply lfo
            const lfo = lfoBuffer[i]
            cutoffBuffer[i] = flt_cutoff
                + this.filter_keyboard_delta
                + vcaBuffer[i] * flt_env_amount
                + lfo * lfo_target_cutoff
            // apply gain
            vcaBuffer[i] *= clampUnit(gain + lfo * lfo_target_volume)
            // compute frequencies
            const frequency = freqBuffer[i] * (2.0 ** (lfo * lfo_target_tune))
            freqBufferA[i] = frequency * frequencyAMultiplier
            freqBufferB[i] = frequency * frequencyBMultiplier
        }

        this.oscA.generateFromFrequencies(oscABuffer, freqBufferA, oscA_waveform, fromIndex, toIndex)
        this.oscB.generateFromFrequencies(oscBBuffer, freqBufferB, oscB_waveform, fromIndex, toIndex)

        for (let i = fromIndex; i < toIndex; i++) {
            oscSumBuffer[i] =
                oscABuffer[i] * this.gainASmooth.process(gainOscA)
                + oscBBuffer[i] * this.gainBSmooth.process(gainOscB)
        }

        this.filter.order = flt_order
        this.filter.process(oscSumBuffer, oscSumBuffer, cutoffBuffer, flt_resonance, fromIndex, toIndex)

        for (let i = fromIndex; i < toIndex; i++) {
            const vca = this.gainVcaSmooth.process(clampUnit(vcaBuffer[i]))
            const out = oscSumBuffer[i] * vca
            outL[i] += out * gainL
            outR[i] += out * gainR
            if (this.env.complete && vca < SILENCE_THRESHOLD) {return true}
        }
        return false
    }
}