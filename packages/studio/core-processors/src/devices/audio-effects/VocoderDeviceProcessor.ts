import {AudioEffectDeviceAdapter, ModulatorMode, VocoderDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {int, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {AudioAnalyser, AudioBuffer, Event, RenderQuantum} from "@opendaw/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {Block, Processor, ProcessPhase} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioProcessor} from "../../AudioProcessor"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {NoiseColor, NoiseGenerator, VocoderDsp} from "./VocoderDsp"

export class VocoderDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = VocoderDeviceProcessor.ID++
    readonly #adapter: VocoderDeviceBoxAdapter

    readonly parameterCarrierMinFreq: AutomatableParameter<number>
    readonly parameterCarrierMaxFreq: AutomatableParameter<number>
    readonly parameterModulatorMinFreq: AutomatableParameter<number>
    readonly parameterModulatorMaxFreq: AutomatableParameter<number>
    readonly parameterQMin: AutomatableParameter<number>
    readonly parameterQMax: AutomatableParameter<number>
    readonly parameterEnvAttack: AutomatableParameter<number>
    readonly parameterEnvRelease: AutomatableParameter<number>
    readonly parameterGain: AutomatableParameter<number>
    readonly parameterMix: AutomatableParameter<number>

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #dsp: VocoderDsp
    readonly #noise: NoiseGenerator

    readonly #analyser: AudioAnalyser
    readonly #spectrum: Float32Array

    readonly #modScratchL: Float32Array
    readonly #modScratchR: Float32Array

    #spectrumMode: "none" | "modulator" | "carrier" = "none"

    readonly #sideChainConnection: Terminator = new Terminator()

    #source: Option<AudioBuffer> = Option.None
    #sideChain: Option<AudioBuffer> = Option.None
    #needsSideChainResolution: boolean = false
    #modulatorMode: ModulatorMode = "noise-pink"

    constructor(context: EngineContext, adapter: VocoderDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#dsp = new VocoderDsp(sampleRate)
        this.#noise = new NoiseGenerator()
        this.#analyser = new AudioAnalyser()
        this.#spectrum = new Float32Array(this.#analyser.numBins())
        this.#modScratchL = new Float32Array(RenderQuantum)
        this.#modScratchR = new Float32Array(RenderQuantum)

        const {
            carrierMinFreq, carrierMaxFreq, modulatorMinFreq, modulatorMaxFreq,
            qMin, qMax, envAttack, envRelease, gain, mix
        } = adapter.namedParameter

        this.parameterCarrierMinFreq = this.own(this.bindParameter(carrierMinFreq))
        this.parameterCarrierMaxFreq = this.own(this.bindParameter(carrierMaxFreq))
        this.parameterModulatorMinFreq = this.own(this.bindParameter(modulatorMinFreq))
        this.parameterModulatorMaxFreq = this.own(this.bindParameter(modulatorMaxFreq))
        this.parameterQMin = this.own(this.bindParameter(qMin))
        this.parameterQMax = this.own(this.bindParameter(qMax))
        this.parameterEnvAttack = this.own(this.bindParameter(envAttack))
        this.parameterEnvRelease = this.own(this.bindParameter(envRelease))
        this.parameterGain = this.own(this.bindParameter(gain))
        this.parameterMix = this.own(this.bindParameter(mix))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            context.broadcaster.broadcastFloats(adapter.modulatorSpectrum, this.#spectrum, (hasSubscribers) => {
                this.#spectrumMode = hasSubscribers ? "modulator" : this.#spectrumMode === "modulator" ? "none" : this.#spectrumMode
                if (hasSubscribers) {
                    this.#spectrum.set(this.#analyser.bins())
                    this.#analyser.decay = true
                }
            }),
            context.broadcaster.broadcastFloats(adapter.carrierSpectrum, this.#spectrum, (hasSubscribers) => {
                this.#spectrumMode = hasSubscribers ? "carrier" : this.#spectrumMode === "carrier" ? "none" : this.#spectrumMode
                if (hasSubscribers) {
                    this.#spectrum.set(this.#analyser.bins())
                    this.#analyser.decay = true
                }
            }),
            adapter.sideChain.catchupAndSubscribe(() => {
                this.#sideChainConnection.terminate()
                this.#sideChain = Option.None
                this.#needsSideChainResolution = true
            }),
            context.subscribeProcessPhase(phase => {
                if (phase === ProcessPhase.Before && this.#needsSideChainResolution) {
                    this.#needsSideChainResolution = false
                    adapter.sideChain.targetVertex.map(({box}) => box.address).ifSome(address => {
                        context.audioOutputBufferRegistry.resolve(address).ifSome(output => {
                            this.#sideChain = Option.wrap(output.buffer)
                            this.#sideChainConnection.own(context.registerEdge(output.processor, this.incoming))
                        })
                    })
                }
            }),
            adapter.box.modulatorSource.catchupAndSubscribe(owner => {
                const value = owner.getValue()
                this.#modulatorMode = this.#parseMode(value)
            }),
            adapter.box.bandCount.catchupAndSubscribe(owner => {
                this.#dsp.bandCount = owner.getValue()
            }),
            this.#sideChainConnection
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#output.clear()
        this.#peaks.clear()
        this.eventInput.clear()
        this.#dsp.reset()
        this.#noise.reset()
        this.#analyser.clear()
        this.#modScratchL.fill(0.0)
        this.#modScratchR.fill(0.0)
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#output}

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    index(): int {return this.#adapter.indexField.getValue()}
    adapter(): AudioEffectDeviceAdapter {return this.#adapter}

    handleEvent(_event: Event): void {}

    processAudio({s0, s1}: Block): void {
        if (this.#source.isEmpty()) return
        const source = this.#source.unwrap()
        const srcL = source.getChannel(0)
        const srcR = source.getChannel(1)
        const outL = this.#output.getChannel(0)
        const outR = this.#output.getChannel(1)

        switch (this.#modulatorMode) {
            case "self":
                this.#dsp.processSelf(srcL, srcR, outL, outR, s0, s1)
                break
            case "noise-white":
            case "noise-pink":
            case "noise-brown": {
                const color: NoiseColor =
                    this.#modulatorMode === "noise-white" ? "white"
                        : this.#modulatorMode === "noise-brown" ? "brown"
                            : "pink"
                this.#noise.fill(color, this.#modScratchL, s0, s1)
                this.#dsp.processMonoMod(srcL, srcR, this.#modScratchL, outL, outR, s0, s1)
                break
            }
            case "external": {
                if (this.#sideChain.nonEmpty()) {
                    const sc = this.#sideChain.unwrap()
                    const scL = sc.getChannel(0)
                    const scR = sc.getChannel(1)
                    this.#dsp.processStereoMod(srcL, srcR, scL, scR, outL, outR, s0, s1)
                } else {
                    // One-block silence fallback while sidechain target is being resolved
                    this.#modScratchL.fill(0.0, s0, s1)
                    this.#modScratchR.fill(0.0, s0, s1)
                    this.#dsp.processStereoMod(srcL, srcR, this.#modScratchL, this.#modScratchR,
                        outL, outR, s0, s1)
                }
                break
            }
        }

        this.#peaks.process(outL, outR, s0, s1)
        if (this.#spectrumMode === "carrier") {
            this.#analyser.process(srcL, srcR, s0, s1)
        } else if (this.#spectrumMode === "modulator") {
            switch (this.#modulatorMode) {
                case "noise-white":
                case "noise-pink":
                case "noise-brown":
                    this.#analyser.process(this.#modScratchL, this.#modScratchL, s0, s1)
                    break
                case "self":
                    this.#analyser.process(srcL, srcR, s0, s1)
                    break
                case "external":
                    if (this.#sideChain.nonEmpty()) {
                        const sc = this.#sideChain.unwrap()
                        this.#analyser.process(sc.getChannel(0), sc.getChannel(1), s0, s1)
                    }
                    break
            }
        }
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterCarrierMinFreq) {
            this.#dsp.carrierMinFreq = this.parameterCarrierMinFreq.getValue()
        } else if (parameter === this.parameterCarrierMaxFreq) {
            this.#dsp.carrierMaxFreq = this.parameterCarrierMaxFreq.getValue()
        } else if (parameter === this.parameterModulatorMinFreq) {
            this.#dsp.modulatorMinFreq = this.parameterModulatorMinFreq.getValue()
        } else if (parameter === this.parameterModulatorMaxFreq) {
            this.#dsp.modulatorMaxFreq = this.parameterModulatorMaxFreq.getValue()
        } else if (parameter === this.parameterQMin) {
            this.#dsp.qMin = this.parameterQMin.getValue()
        } else if (parameter === this.parameterQMax) {
            this.#dsp.qMax = this.parameterQMax.getValue()
        } else if (parameter === this.parameterEnvAttack) {
            this.#dsp.setAttackSeconds(this.parameterEnvAttack.getValue() * 0.001)
        } else if (parameter === this.parameterEnvRelease) {
            this.#dsp.setReleaseSeconds(this.parameterEnvRelease.getValue() * 0.001)
        } else if (parameter === this.parameterGain) {
            this.#dsp.gain = this.parameterGain.getValue()
        } else if (parameter === this.parameterMix) {
            this.#dsp.mix = this.parameterMix.getValue()
        }
    }

    #parseMode(raw: string): ModulatorMode {
        switch (raw) {
            case "noise-white":
            case "noise-pink":
            case "noise-brown":
            case "self":
            case "external":
                return raw
            default:
                return "noise-pink"
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}
}
