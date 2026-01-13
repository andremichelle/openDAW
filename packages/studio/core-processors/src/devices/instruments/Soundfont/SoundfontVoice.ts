import type {Generator, InstrumentZone, PresetZone, SoundFont2, ZoneMap} from "soundfont2"
import {
    Adsr,
    AudioBuffer,
    midiToHz,
    NoteEvent,
    RenderQuantum,
    SILENCE_THRESHOLD,
    Smooth,
    velocityToGain
} from "@moises-ai/lib-dsp"
import {Id, int, isNotUndefined, Optional} from "@moises-ai/lib-std"
import {GeneratorType} from "./GeneratorType"

const getNumericGenerator = (generators: ZoneMap<Generator>, type: GeneratorType): Optional<number> =>
    (generators[type] ?? generators[type.toString() as unknown as keyof typeof generators])?.value

const getCombinedGenerator = (presetGens: ZoneMap<Generator>, instGens: ZoneMap<Generator>,
                              type: GeneratorType): Optional<number> =>
    getNumericGenerator(instGens, type) ?? getNumericGenerator(presetGens, type)

const envBuffer = new Float32Array(RenderQuantum)

export class SoundfontVoice {
    readonly event: Id<NoteEvent>
    readonly sampleData: Int16Array
    readonly envelope: Adsr
    readonly #gainSmooth: Smooth
    readonly rootKey: number
    readonly sampleRate: number
    readonly loopStart: number
    readonly loopEnd: number
    readonly pan: number
    readonly shouldLoop: boolean

    playbackPosition: number = 0
    isReleasing: boolean = false

    constructor(event: Id<NoteEvent>, presetZone: PresetZone, instrumentZone: InstrumentZone, soundFont: SoundFont2) {
        this.event = event

        const presetGens = presetZone.generators
        const instGens = instrumentZone?.generators

        const sampleId = getNumericGenerator(instGens, GeneratorType.SampleId) ?? 0
        const sample = instrumentZone?.sample ?? soundFont.samples[sampleId]
        this.sampleData = sample.data
        this.rootKey = getNumericGenerator(instGens, GeneratorType.OverridingRootKey) ?? sample?.header.originalPitch ?? 60
        this.sampleRate = sample?.header.sampleRate ?? sampleRate
        this.loopStart = sample?.header.startLoop ?? 0
        this.loopEnd = sample?.header.endLoop ?? this.sampleData.length

        // SampleModes: 0 = no loop, 1 = loop continuously, 3 = loop until note off
        const sampleModes = getCombinedGenerator(presetGens, instGens, GeneratorType.SampleModes) ?? 0
        this.shouldLoop = sampleModes === 1 || sampleModes === 3
        this.pan = (getCombinedGenerator(presetGens, instGens, GeneratorType.Pan) ?? 0) / 1000

        const attack = getCombinedGenerator(presetGens, instGens, GeneratorType.AttackVolEnv)
        const decay = getCombinedGenerator(presetGens, instGens, GeneratorType.DecayVolEnv)
        const sustain = getCombinedGenerator(presetGens, instGens, GeneratorType.SustainVolEnv)
        const release = getCombinedGenerator(presetGens, instGens, GeneratorType.ReleaseVolEnv)

        const attackTime = isNotUndefined(attack) ? Math.pow(2.0, attack / 1200.0) : 0.005
        const decayTime = isNotUndefined(decay) ? Math.pow(2.0, decay / 1200.0) : 0.005
        const sustainLevel = 1.0 - (sustain ?? 0.0) / 1000.0
        const releaseTime = isNotUndefined(release) ? Math.pow(2.0, release / 1200.0) : 0.005
        this.envelope = new Adsr(sampleRate)
        this.envelope.set(attackTime, decayTime, sustainLevel, releaseTime)
        this.envelope.gateOn()
        this.#gainSmooth = new Smooth(0.003, sampleRate)
    }

    release(): void {
        this.isReleasing = true
        this.envelope.gateOff()
    }

    processAdd(output: AudioBuffer, fromIndex: int, toIndex: int): boolean {
        const pitchRatio = midiToHz(this.event.pitch + this.event.cent / 100, 440) / midiToHz(this.rootKey, 440)
        const playbackRate = pitchRatio * (this.sampleRate / sampleRate)
        const gain = velocityToGain(this.event.velocity)
        const panLeft = Math.cos((this.pan + 1) * Math.PI / 4)
        const panRight = Math.sin((this.pan + 1) * Math.PI / 4)
        this.envelope.process(envBuffer, fromIndex, toIndex)
        const l = output.getChannel(0)
        const r = output.getChannel(1)
        for (let i = fromIndex; i < toIndex; i++) {
            const sampleIndex = Math.floor(this.playbackPosition)
            const sample = this.#getSample(sampleIndex)
            const amp = (sample / 32768.0) * gain * this.#gainSmooth.process(envBuffer[i])
            l[i] += amp * panLeft
            r[i] += amp * panRight
            this.playbackPosition += playbackRate
            if (this.shouldLoop) {
                if (this.playbackPosition >= this.loopEnd && this.loopEnd > this.loopStart) {
                    this.playbackPosition = this.loopStart + (this.playbackPosition - this.loopEnd)
                }
            } else {
                if (this.playbackPosition >= this.sampleData.length - 1) {
                    return true
                }
            }
        }
        return this.envelope.complete && this.#gainSmooth.value < SILENCE_THRESHOLD
    }

    #getSample(index: number): number {
        if (index >= this.sampleData.length - 1) return this.sampleData[this.sampleData.length - 1]
        const frac = this.playbackPosition - index
        return this.sampleData[index] * (1.0 - frac) + this.sampleData[index + 1] * frac
    }
}