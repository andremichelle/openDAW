import {AudioUnitBoxAdapter, AudioUnitInputAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "./EngineContext"
import {asInstanceOf, int, Option, Terminable, Terminator} from "@opendaw/lib-std"
import {InstrumentDeviceProcessorFactory} from "./DeviceProcessorFactory"
import {AudioBusProcessor} from "./AudioBusProcessor"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {AudioDeviceChain} from "./AudioDeviceChain"
import {MidiDeviceChain} from "./MidiDeviceChain"
import {AudioUnitOptions} from "./AudioUnitOptions"
import {InstrumentDeviceProcessor} from "./InstrumentDeviceProcessor"
import {FrozenPlaybackProcessor} from "./FrozenPlaybackProcessor"

export class AudioUnit implements Terminable {
    static ID: int = 0 | 0

    readonly #id: int = AudioUnit.ID++

    readonly #terminator = new Terminator()

    readonly #context: EngineContext
    readonly #adapter: AudioUnitBoxAdapter

    readonly #midiDeviceChain: MidiDeviceChain
    readonly #audioDeviceChain: AudioDeviceChain

    #input: Option<InstrumentDeviceProcessor | AudioBusProcessor> = Option.None
    #frozen: Option<{data: AudioData, processor: FrozenPlaybackProcessor}> = Option.None
    #preChannelStripSource: Option<AudioBuffer> = Option.None

    readonly #useInstrumentOutput: boolean
    readonly #skipChannelStrip: boolean

    constructor(context: EngineContext, adapter: AudioUnitBoxAdapter, options: AudioUnitOptions) {
        this.#context = context
        this.#adapter = adapter
        this.#useInstrumentOutput = options.useInstrumentOutput
        this.#skipChannelStrip = options.skipChannelStrip === true

        this.#midiDeviceChain = this.#terminator.own(new MidiDeviceChain(this))
        this.#audioDeviceChain = this.#terminator.own(new AudioDeviceChain(this, options))

        this.#terminator.ownAll(
            this.#adapter.input.catchupAndSubscribe(owner => {
                this.#midiDeviceChain.invalidateWiring()
                this.#audioDeviceChain.invalidateWiring()
                this.#input.ifSome(input => input.terminate())
                this.#input = owner.flatMap((input: AudioUnitInputAdapter) =>
                    Option.wrap(InstrumentDeviceProcessorFactory.create(context, input.box.box)))
            })
        )
    }

    input(): Option<InstrumentDeviceProcessor | AudioBusProcessor> {return this.#input}
    inputAsAudioBus(): AudioBusProcessor {return asInstanceOf(this.#input.unwrap("No input available"), AudioBusProcessor)}
    audioOutput(): AudioBuffer {
        if (this.#useInstrumentOutput) {return this.#input.unwrap().audioOutput}
        if (this.#skipChannelStrip && this.#preChannelStripSource.nonEmpty()) {
            return this.#preChannelStripSource.unwrap()
        }
        return this.#audioDeviceChain.channelStrip.audioOutput
    }
    get frozen(): Option<{data: AudioData, processor: FrozenPlaybackProcessor}> {return this.#frozen}
    get skipChannelStrip(): boolean {return this.#skipChannelStrip}
    setFrozenAudio(data: Option<AudioData>): void {
        this.#frozen.ifSome(frozen => frozen.processor.terminate())
        this.#frozen = data.map(audioData => ({
            data: audioData,
            processor: new FrozenPlaybackProcessor(this.#context, audioData)
        }))
        this.#midiDeviceChain.invalidateWiring()
        this.invalidateWiring()
    }
    setPreChannelStripSource(source: Option<AudioBuffer>): void {this.#preChannelStripSource = source}

    get midiDeviceChain(): MidiDeviceChain {return this.#midiDeviceChain}
    get audioDeviceChain(): AudioDeviceChain {return this.#audioDeviceChain}
    get context(): EngineContext {return this.#context}
    get adapter(): AudioUnitBoxAdapter {return this.#adapter}
    invalidateWiring(): void {this.#audioDeviceChain.invalidateWiring()}
    setMonitoringChannels(channels: ReadonlyArray<int>): void {this.#audioDeviceChain.setMonitoringChannels(channels)}
    clearMonitoringChannels(): void {this.#audioDeviceChain.clearMonitoringChannels()}

    terminate(): void {
        this.#frozen.ifSome(frozen => frozen.processor.terminate())
        this.#frozen = Option.None
        this.#terminator.terminate()
        this.#input.ifSome(input => input.terminate())
        this.#input = Option.None
    }

    toString(): string {return `{${this.constructor.name}(${this.#id})}`}
}