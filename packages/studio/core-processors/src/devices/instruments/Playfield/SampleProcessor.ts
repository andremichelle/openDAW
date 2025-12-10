import {int, UUID} from "@opendaw/lib-std"
import {AudioBuffer, Event} from "@opendaw/lib-dsp"
import {PlayfieldSampleBoxAdapter} from "@opendaw/studio-adapters"
import {AudioProcessor} from "../../../AudioProcessor"
import {AudioGenerator, Block, Processor} from "../../../processing"
import {EngineContext} from "../../../EngineContext"
import {InsertReturnAudioChain} from "../../../InsertReturnAudioChain"
import {AutomatableParameter} from "../../../AutomatableParameter"
import {PeakBroadcaster} from "../../../PeakBroadcaster"
import {NoteLifecycleEvent} from "../../../NoteEventSource"
import {PlayfieldDeviceProcessor} from "../PlayfieldDeviceProcessor"
import {SampleVoice} from "./SampleVoice"
import {AutomatableParameters} from "./AutomatableParameters"
import {MixProcessor} from "./MixProcessor"
import {DeviceProcessor} from "../../../DeviceProcessor"

export class SampleProcessor extends AudioProcessor implements DeviceProcessor, AudioGenerator {
    readonly #device: PlayfieldDeviceProcessor
    readonly #adapter: PlayfieldSampleBoxAdapter

    readonly #voices: Array<SampleVoice>
    readonly #audioOutput: AudioBuffer
    readonly #peaksBroadcaster: PeakBroadcaster

    readonly #parameters: AutomatableParameters

    constructor(context: EngineContext,
                device: PlayfieldDeviceProcessor,
                adapter: PlayfieldSampleBoxAdapter,
                mixProcessor: MixProcessor) {
        super(context)

        this.#device = device
        this.#adapter = adapter

        this.#voices = []
        this.#audioOutput = new AudioBuffer()
        this.#peaksBroadcaster = this.own(new PeakBroadcaster(context.broadcaster, adapter.peakAddress))

        const {sampleStart, sampleEnd, attack, release, pitch} = adapter.namedParameter

        this.#parameters = Object.freeze({
            sampleStart: this.own(this.bindParameter(sampleStart)),
            sampleEnd: this.own(this.bindParameter(sampleEnd)),
            attack: this.own(this.bindParameter(attack)),
            release: this.own(this.bindParameter(release)),
            pitch: this.own(this.bindParameter(pitch))
        })

        const positions = new Float32Array(16) // we just assume that 16 voices per channels are enough to visualize
        this.ownAll(
            InsertReturnAudioChain.create(context, adapter.audioEffects, this, mixProcessor),
            context.broadcaster.broadcastFloats(adapter.address, positions, (hasSubscribers) => {
                if (!hasSubscribers) {return}
                const slices = this.#voices.length < positions.length ? this.#voices : this.#voices.slice(0, positions.length)
                slices.forEach(({position}, index) => positions[index] = position)
                positions[slices.length] = -1.0 // close stream
            }),
            context.registerProcessor(this)
        )
        this.readAllParameters()
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}
    get audioOutput(): AudioBuffer {return this.#audioOutput}

    get adapter(): PlayfieldSampleBoxAdapter {return this.#adapter}

    handleEvent(event: Event) {
        if (NoteLifecycleEvent.isStart(event)) {
            const optData = this.#adapter.file().flatMap(file => file.getOrCreateLoader().data)
            if (optData.isEmpty()) {return}
            const {mute, solo, polyphone, exclude} = this.#adapter.namedParameter
            const isMute = mute.getValue()
            const isSolo = solo.getValue()
            const silent = isMute || (this.#device.hasSolo() && !isSolo)
            if (silent) {return}
            if (!polyphone.getValue()) {this.#voices.forEach(voice => voice.release(true))}
            if (exclude.getValue()) {this.#device.stopExcludeOthers(this.#adapter)}
            this.#voices.push(new SampleVoice(this.#adapter, this.#parameters, optData.unwrap(), event))
        } else if (NoteLifecycleEvent.isStop(event)) {
            this.#voices.find(voice => voice.event.id === event.id)?.release()
        }
    }

    processAudio(_block: Block, fromIndex: int, toIndex: int): void {
        this.#audioOutput.clear(fromIndex, toIndex)
        for (let i = this.#voices.length - 1; i >= 0; i--) {
            if (this.#voices[i].processAdd(this.#audioOutput.channels(), fromIndex, toIndex)) {
                this.#voices.splice(i, 1)
            }
        }
    }

    forceStop(): void {this.#voices.forEach(voice => voice.release(true))}

    parameterChanged(_parameter: AutomatableParameter): void {}

    reset(): void {
        this.#voices.length = 0
        this.#audioOutput.clear()
        this.#peaksBroadcaster.clear()
    }

    finishProcess(): void {
        this.#audioOutput.assertSanity()
        this.#peaksBroadcaster.process(this.#audioOutput.getChannel(0), this.#audioOutput.getChannel(1))
    }

    toString(): string {return `{PlayfieldSampleProcessor note: ${this.#adapter.indexField.getValue()}}`}
}