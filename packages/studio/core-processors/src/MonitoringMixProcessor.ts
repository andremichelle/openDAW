import {int, Option, Terminable} from "@opendaw/lib-std"
import {AudioBuffer, RenderQuantum} from "@opendaw/lib-dsp"
import {AbstractProcessor} from "./AbstractProcessor"
import {EngineContext} from "./EngineContext"
import {AudioInput, ProcessInfo, Processor} from "./processing"

export class MonitoringMixProcessor extends AbstractProcessor implements Processor, AudioInput {
    #source: Option<AudioBuffer> = Option.None
    #channels: Option<ReadonlyArray<int>> = Option.None

    constructor(context: EngineContext) {
        super(context)
    }

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    setChannels(channels: ReadonlyArray<int>): void {
        this.#channels = Option.wrap(channels)
    }

    clearChannels(): void {
        this.#channels = Option.None
    }

    get isActive(): boolean {
        return this.#channels.nonEmpty()
    }

    reset(): void {}

    process(_processInfo: ProcessInfo): void {
        if (this.#source.isEmpty() || this.#channels.isEmpty()) {return}
        const [targetL, targetR] = this.#source.unwrap().channels()
        const channels = this.#channels.unwrap()
        const optL = this.context.getMonitoringChannel(channels[0])
        if (optL.isEmpty()) {return}
        const inputL = optL.unwrap()
        const inputR = channels.length === 2
            ? this.context.getMonitoringChannel(channels[1]).unwrapOrElse(inputL)
            : inputL
        for (let i = 0; i < RenderQuantum; i++) {
            targetL[i] += inputL[i]
            targetR[i] += inputR[i]
        }
    }
}
