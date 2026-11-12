import {int, Notifier, Observer, Option, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {Peaks} from "@opendaw/lib-fusion"
import {AudioLease, SampleLoader, SampleLoaderState, SampleMetaData, SampleRetention} from "@opendaw/studio-adapters"
import {AudioData, AudioInfo, PcmData} from "@opendaw/lib-dsp"
import {SampleStorage} from "./SampleStorage"

export class DefaultSampleLoader implements SampleLoader {
    readonly #uuid: UUID.Bytes
    readonly #retention: SampleRetention
    readonly #notifier: Notifier<SampleLoaderState>

    #meta: Option<SampleMetaData> = Option.None
    #info: Option<AudioInfo> = Option.None
    #data: Option<AudioData> = Option.None
    #peaks: Option<Peaks> = Option.None
    #state: SampleLoaderState = {type: "progress", progress: 0.0}
    // what was let go, found again for as long as nothing collected it
    #released: Option<WeakRef<AudioData>> = Option.None
    #stored: Option<WeakRef<PcmData>> = Option.None
    #leases: int = 0
    // reads under way, shared by everybody who asks meanwhile
    #reading: Option<Promise<PcmData>> = Option.None
    #inflating: Option<Promise<AudioData>> = Option.None

    constructor(uuid: UUID.Bytes, retention: SampleRetention = "always") {
        this.#uuid = uuid
        this.#retention = retention
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
    get info(): Option<AudioInfo> {return this.#info}
    get meta(): Option<SampleMetaData> {return this.#meta}
    get peaks(): Option<Peaks> {return this.#peaks}
    get state(): SampleLoaderState {return this.#state}
    get retention(): SampleRetention {return this.#retention}
    get leases(): int {return this.#leases}

    setLoaded(data: AudioData, peaks: Peaks, meta: SampleMetaData): void {
        const {sampleRate, numberOfFrames, numberOfChannels} = data
        this.#info = Option.wrap({sampleRate, numberOfFrames, numberOfChannels})
        this.#released = Option.wrap(new WeakRef(data))
        this.#stored = Option.None
        this.#data = this.#holds() ? Option.wrap(data) : Option.None
        this.#finish(peaks, meta)
    }

    // loaded without frames in memory: the sample is in storage and is read from there when leased
    setStored(info: AudioInfo, peaks: Peaks, meta: SampleMetaData, fresh: Option<PcmData>): void {
        const {sampleRate, numberOfFrames, numberOfChannels} = info
        this.#info = Option.wrap({sampleRate, numberOfFrames, numberOfChannels})
        this.#released = Option.None
        this.#stored = fresh.map(pcm => new WeakRef(pcm))
        this.#data = this.#holds() ? fresh.map(pcm => PcmData.floats(pcm)) : Option.None
        this.#finish(peaks, meta)
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
        this.#info = Option.None
        this.#data = Option.None
        this.#peaks = Option.None
        this.#released = Option.None
        this.#stored = Option.None
        this.#reading = Option.None
        this.#inflating = Option.None
        this.#notifier.notify(this.#state)
    }

    async acquire(): Promise<AudioLease> {
        await SampleLoader.loaded(this)
        this.#leases++
        const data = await this.#frames().catch((reason: unknown) => {
            this.#leases--
            return Promise.reject(reason)
        })
        this.#data = Option.wrap(data)
        this.#released = Option.wrap(new WeakRef(data))
        let terminated = false
        return {
            data,
            terminate: () => {
                if (terminated) {return}
                terminated = true
                if (--this.#leases === 0 && !this.#holds()) {this.#data = Option.None}
            }
        }
    }

    async pcm(): Promise<PcmData> {
        await SampleLoader.loaded(this)
        const stored = this.#fresh()
        if (stored.nonEmpty()) {return stored.unwrap()}
        const floats = this.#known()
        if (floats.nonEmpty()) {
            const audio = floats.unwrap()
            const pcm: PcmData = SampleStorage.get().format === "smallest" ? PcmData.smallest(audio) : {format: "float32", ...audio}
            this.#stored = Option.wrap(new WeakRef(pcm))
            return pcm
        }
        return this.#read()
    }

    toString(): string {return `{DefaultSampleLoader ${UUID.toString(this.#uuid)}}`}

    #holds(): boolean {return this.#retention === "always" || this.#leases > 0}

    #known(): Option<AudioData> {
        return this.#data.nonEmpty() ? this.#data : this.#released.map(reference => reference.deref())
    }

    #fresh(): Option<PcmData> {return this.#stored.map(reference => reference.deref())}

    #finish(peaks: Peaks, meta: SampleMetaData): void {
        this.#peaks = Option.wrap(peaks)
        this.#meta = Option.wrap(meta)
        this.#state = {type: "loaded"}
        this.#notifier.notify(this.#state)
    }

    #frames(): Promise<AudioData> {
        const known = this.#known()
        if (known.nonEmpty()) {return Promise.resolve(known.unwrap())}
        if (this.#inflating.isEmpty()) {
            const stored = this.#fresh()
            const inflating = (stored.nonEmpty() ? Promise.resolve(stored.unwrap()) : this.#read()).then(pcm => {
                const audio = PcmData.floats(pcm)
                this.#released = Option.wrap(new WeakRef(audio))
                return audio
            }).finally(() => this.#inflating = Option.None)
            this.#inflating = Option.wrap(inflating)
        }
        return this.#inflating.unwrap()
    }

    #read(): Promise<PcmData> {
        if (this.#reading.isEmpty()) {
            const reading = SampleStorage.get().loadPcm(this.#uuid).then(pcm => {
                this.#stored = Option.wrap(new WeakRef(pcm))
                return pcm
            }).finally(() => this.#reading = Option.None)
            this.#reading = Option.wrap(reading)
        }
        return this.#reading.unwrap()
    }
}
