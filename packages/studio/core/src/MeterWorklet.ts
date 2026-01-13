import {int, Notifier, Observer, Schema, Subscription, SyncStream, Terminable, Terminator} from "@moises-ai/lib-std"
import {AnimationFrame} from "@moises-ai/lib-dom"
import {PeakMeterProcessorOptions} from "@moises-ai/studio-adapters"

export type PeakSchema = { peak: Float32Array, rms: Float32Array }

export class MeterWorklet extends AudioWorkletNode implements Terminable {
    readonly #terminator: Terminator = new Terminator()
    readonly #notifier: Notifier<PeakSchema> = this.#terminator.own(new Notifier<PeakSchema>())

    constructor(context: BaseAudioContext, numberOfChannels: int) {
        const receiver = SyncStream.reader(Schema.createBuilder({
            peak: Schema.floats(numberOfChannels),
            rms: Schema.floats(numberOfChannels)
        })(), (data: PeakSchema) => this.#notifier.notify(data))
        super(context, "meter-processor", {
            numberOfInputs: 1,
            channelCount: numberOfChannels,
            channelCountMode: "explicit",
            processorOptions: {
                sab: receiver.buffer,
                numberOfChannels,
                rmsWindowInSeconds: 0.100,
                valueDecay: 0.200
            } satisfies PeakMeterProcessorOptions
        })
        this.#terminator.ownAll(
            AnimationFrame.add(() => receiver.tryRead())
        )
    }

    subscribe(observer: Observer<PeakSchema>): Subscription {return this.#notifier.subscribe(observer)}
    terminate(): void {this.#terminator.terminate()}
}