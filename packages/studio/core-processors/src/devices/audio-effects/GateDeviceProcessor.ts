import {AudioEffectDeviceAdapter, GateDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {int, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {AudioBuffer, dbToGain, Event, gainToDb} from "@opendaw/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {Block, Processor, ProcessPhase} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioProcessor} from "../../AudioProcessor"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"

export class GateDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static readonly PEAK_DECAY_PER_SAMPLE = Math.exp(-1.0 / (sampleRate * 0.030))

    static ID: int = 0 | 0

    readonly #id: int = GateDeviceProcessor.ID++
    readonly #adapter: GateDeviceBoxAdapter

    readonly parameterThreshold: AutomatableParameter<number>
    readonly parameterReturn: AutomatableParameter<number>
    readonly parameterAttack: AutomatableParameter<number>
    readonly parameterHold: AutomatableParameter<number>
    readonly parameterRelease: AutomatableParameter<number>
    readonly parameterFloor: AutomatableParameter<number>

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    readonly #editorValues: Float32Array
    readonly #sideChainConnection: Terminator = new Terminator()

    #source: Option<AudioBuffer> = Option.None
    #sideChain: Option<AudioBuffer> = Option.None
    #needsSideChainResolution: boolean = false

    #threshold: number = -40.0
    #return: number = 6.0
    #attack: number = 0.5
    #hold: number = 50.0
    #release: number = 100.0
    #floor: number = -80.0

    #thresholdGain: number = dbToGain(-40.0)
    #returnThresholdGain: number = dbToGain(-46.0)
    #floorGain: number = dbToGain(-80.0)
    #holdSamples: int = 0 | 0
    #attackCoeff: number = 0.0
    #releaseCoeff: number = 0.0

    #envelope: number = 0.0
    #holdCounter: int = 0 | 0
    #gateOpen: boolean = false
    #inpMax: number = 0.0
    #outMax: number = 0.0

    constructor(context: EngineContext, adapter: GateDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        // [0] inputPeakDb, [1] outputPeakDb, [2] gateEnvelopeDb
        this.#editorValues = new Float32Array([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY])

        const {threshold, return: returnParam, attack, hold, release, floor} = adapter.namedParameter

        this.parameterThreshold = this.own(this.bindParameter(threshold))
        this.parameterReturn = this.own(this.bindParameter(returnParam))
        this.parameterAttack = this.own(this.bindParameter(attack))
        this.parameterHold = this.own(this.bindParameter(hold))
        this.parameterRelease = this.own(this.bindParameter(release))
        this.parameterFloor = this.own(this.bindParameter(floor))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            context.broadcaster.broadcastFloats(adapter.address.append(0),
                this.#editorValues, (_hasSubscribers) => {
                    this.#editorValues[0] = gainToDb(this.#inpMax)
                    this.#editorValues[1] = gainToDb(this.#outMax)
                    this.#editorValues[2] = gainToDb(this.#envelope)
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
            this.#sideChainConnection
        )
        this.readAllParameters()
        this.#updateCoefficients()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#output.clear()
        this.#peaks.clear()
        this.eventInput.clear()
        this.#envelope = 0.0
        this.#holdCounter = 0
        this.#gateOpen = false
        this.#inpMax = 0.0
        this.#outMax = 0.0
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

    processAudio(_block: Block, from: int, to: int): void {
        if (this.#source.isEmpty()) return
        const source = this.#source.unwrap()
        const srcL = source.getChannel(0)
        const srcR = source.getChannel(1)
        const outL = this.#output.getChannel(0)
        const outR = this.#output.getChannel(1)
        const useSidechain = this.#sideChain.nonEmpty()
        const scL = useSidechain ? this.#sideChain.unwrap().getChannel(0) : srcL
        const scR = useSidechain ? this.#sideChain.unwrap().getChannel(1) : srcR
        for (let i = from; i < to; i++) {
            const level = Math.max(Math.abs(scL[i]), Math.abs(scR[i]))
            if (this.#inpMax <= level) {
                this.#inpMax = level
            } else {
                this.#inpMax *= GateDeviceProcessor.PEAK_DECAY_PER_SAMPLE
            }
            if (level >= this.#thresholdGain) {
                this.#gateOpen = true
                this.#holdCounter = this.#holdSamples
            } else if (this.#gateOpen && this.#holdCounter > 0) {
                this.#holdCounter--
            } else if (level < this.#returnThresholdGain) {
                this.#gateOpen = false
            }
            const target = this.#gateOpen ? 1.0 : 0.0
            if (target > this.#envelope) {
                this.#envelope = this.#attackCoeff * this.#envelope + (1.0 - this.#attackCoeff) * target
            } else {
                this.#envelope = this.#releaseCoeff * this.#envelope + (1.0 - this.#releaseCoeff) * target
            }
            const gain = this.#floorGain + (1.0 - this.#floorGain) * this.#envelope
            const l = srcL[i] * gain
            const r = srcR[i] * gain
            outL[i] = l
            outR[i] = r
            const outPeak = Math.max(Math.abs(l), Math.abs(r))
            if (this.#outMax <= outPeak) {
                this.#outMax = outPeak
            } else {
                this.#outMax *= GateDeviceProcessor.PEAK_DECAY_PER_SAMPLE
            }
        }

        this.#peaks.process(outL, outR, from, to)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterThreshold) {
            this.#threshold = this.parameterThreshold.getValue()
            this.#thresholdGain = dbToGain(this.#threshold)
            this.#returnThresholdGain = dbToGain(this.#threshold - this.#return)
        } else if (parameter === this.parameterReturn) {
            this.#return = this.parameterReturn.getValue()
            this.#returnThresholdGain = dbToGain(this.#threshold - this.#return)
        } else if (parameter === this.parameterAttack) {
            this.#attack = this.parameterAttack.getValue()
            this.#updateCoefficients()
        } else if (parameter === this.parameterHold) {
            this.#hold = this.parameterHold.getValue()
            this.#holdSamples = Math.round(this.#hold * 0.001 * sampleRate) | 0
        } else if (parameter === this.parameterRelease) {
            this.#release = this.parameterRelease.getValue()
            this.#updateCoefficients()
        } else if (parameter === this.parameterFloor) {
            this.#floor = this.parameterFloor.getValue()
            this.#floorGain = dbToGain(this.#floor)
        }
    }

    #updateCoefficients(): void {
        const attackSeconds = this.#attack * 0.001
        const releaseSeconds = this.#release * 0.001
        this.#attackCoeff = Math.exp(-1.0 / (sampleRate * attackSeconds))
        this.#releaseCoeff = Math.exp(-1.0 / (sampleRate * releaseSeconds))
        this.#holdSamples = Math.round(this.#hold * 0.001 * sampleRate) | 0
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}
}