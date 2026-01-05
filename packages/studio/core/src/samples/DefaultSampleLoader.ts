import {Notifier, Observer, Option, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {Peaks} from "@opendaw/lib-fusion"
import {SampleLoader, SampleLoaderState, SampleMetaData} from "@opendaw/studio-adapters"
import {AudioData} from "@opendaw/lib-dsp"

export class DefaultSampleLoader implements SampleLoader {
    readonly #uuid: UUID.Bytes
    readonly #notifier: Notifier<SampleLoaderState>

    #meta: Option<SampleMetaData> = Option.None
    #data: Option<AudioData> = Option.None
    #peaks: Option<Peaks> = Option.None
    #state: SampleLoaderState = {type: "progress", progress: 0.0}

    constructor(uuid: UUID.Bytes) {
        this.#uuid = uuid
        this.#notifier = new Notifier<SampleLoaderState>()
    }

    subscribe(observer: Observer<SampleLoaderState>): Subscription {
        if (this.#state.type === "loaded" || this.#state.type === "error") {
            observer(this.#state)
            return Terminable.Empty
        }
        return this.#notifier.subscribe(observer)
    }

    get uuid(): UUID.Bytes {return this.#uuid}
    get data(): Option<AudioData> {return this.#data}
    get meta(): Option<SampleMetaData> {return this.#meta}
    get peaks(): Option<Peaks> {return this.#peaks}
    get state(): SampleLoaderState {return this.#state}

    setLoaded(data: AudioData, peaks: Peaks, meta: SampleMetaData): void {
        this.#data = Option.wrap(data)
        this.#peaks = Option.wrap(peaks)
        this.#meta = Option.wrap(meta)
        this.#state = {type: "loaded"}
        this.#notifier.notify(this.#state)
    }

    setProgress(progress: number): void {
        this.#state = {type: "progress", progress}
        this.#notifier.notify(this.#state)
    }

    setError(reason: string): void {
        this.#state = {type: "error", reason}
        this.#notifier.notify(this.#state)
    }

    invalidate(): void {
        this.#state = {type: "progress", progress: 0.0}
        this.#meta = Option.None
        this.#data = Option.None
        this.#peaks = Option.None
        this.#notifier.notify(this.#state)
    }

    toString(): string {return `{DefaultSampleLoader ${UUID.toString(this.#uuid)}}`}
}
