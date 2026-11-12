import {ByteArrayInput, int, Option, Progress, SortedSet, Terminable, UUID} from "@opendaw/lib-std"
import {DefaultSampleLoader} from "./DefaultSampleLoader"
import {SampleProvider} from "./SampleProvider"
import {SampleLoader, SampleLoaderManager, SampleMetaData, SampleRetention} from "@opendaw/studio-adapters"
import {AudioData, AudioInfo, PcmData} from "@opendaw/lib-dsp"
import {SampleStorage} from "./SampleStorage"
import {Peaks, SamplePeaks} from "@opendaw/lib-fusion"
import {Workers} from "../Workers"
import {Promises} from "@opendaw/lib-runtime"

type CachedSample = {
    uuid: UUID.Bytes
    // absent where frames are only kept while they are used
    data: Option<AudioData>
    info: AudioInfo
    peaks: Peaks
    meta: SampleMetaData
}

type RefCount = {
    uuid: UUID.Bytes
    count: int
}

type PendingLoad = {
    uuid: UUID.Bytes
    promise: Promise<void>
}

export namespace GlobalSampleLoaderManager {
    export type Options = { readonly retain?: SampleRetention }
}

export class GlobalSampleLoaderManager implements SampleLoaderManager, SampleProvider {
    readonly #provider: SampleProvider
    readonly #retain: SampleRetention
    readonly #loaders: SortedSet<UUID.Bytes, SampleLoader>
    readonly #refCounts: SortedSet<UUID.Bytes, RefCount>
    readonly #cache: SortedSet<UUID.Bytes, CachedSample>
    readonly #pending: SortedSet<UUID.Bytes, PendingLoad>

    constructor(provider: SampleProvider, options?: GlobalSampleLoaderManager.Options) {
        this.#provider = provider
        this.#retain = options?.retain ?? "always"
        this.#loaders = UUID.newSet(({uuid}) => uuid)
        this.#refCounts = UUID.newSet(({uuid}) => uuid)
        this.#cache = UUID.newSet(({uuid}) => uuid)
        this.#pending = UUID.newSet(({uuid}) => uuid)
    }

    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]> {
        return this.#provider.fetch(uuid, progress)
    }

    remove(uuid: UUID.Bytes): void {
        this.#refCounts.removeByKeyIfExist(uuid)
        this.#loaders.removeByKeyIfExist(uuid)
        this.#cache.removeByKeyIfExist(uuid)
        this.#pending.removeByKeyIfExist(uuid)
    }

    invalidate(uuid: UUID.Bytes): void {
        this.#cache.removeByKeyIfExist(uuid)
        this.#pending.removeByKeyIfExist(uuid)
        this.#loaders.opt(uuid).ifSome(loader => {
            loader.invalidate()
            if (loader instanceof DefaultSampleLoader) {
                this.#load(loader)
            }
        })
    }

    register(uuid: UUID.Bytes): Terminable {
        const current = this.#refCounts.opt(uuid)
        if (current.nonEmpty()) {
            current.unwrap().count++
        } else {
            this.#refCounts.add({uuid, count: 1})
        }
        return {
            terminate: () => {
                const ref = this.#refCounts.opt(uuid)
                if (ref.isEmpty()) {return}
                const {count} = ref.unwrap()
                if (count <= 1) {
                    this.#refCounts.removeByKey(uuid)
                    this.#loaders.removeByKeyIfExist(uuid)
                    this.#cache.removeByKeyIfExist(uuid)
                } else {
                    ref.unwrap().count--
                }
            }
        }
    }

    record(loader: SampleLoader): void {
        this.#loaders.add(loader)
    }

    getOrCreate(uuid: UUID.Bytes): SampleLoader {
        return this.#loaders.getOrCreate(uuid, uuid => {
            const loader = new DefaultSampleLoader(uuid, this.#retain, uuid => this.#restore(uuid))
            this.#load(loader)
            return loader
        })
    }

    get retain(): SampleRetention {return this.#retain}

    async getAudioData(uuid: UUID.Bytes): Promise<AudioData> {return SampleLoader.frames(this.getOrCreate(uuid))}

    #load(loader: DefaultSampleLoader): void {
        const {uuid} = loader
        const cached = this.#cache.opt(uuid)
        if (cached.nonEmpty()) {
            this.#apply(loader, cached.unwrap())
            return
        }
        const pending = this.#pending.opt(uuid)
        if (pending.nonEmpty()) {
            pending.unwrap().promise.then(() => {
                this.#cache.opt(uuid).ifSome(cached => this.#apply(loader, cached))
            })
            return
        }
        const fetch = (): Promise<void> => this.#fetchFromApi(loader)
        const stored: Promise<void> = this.#retain === "always"
            ? SampleStorage.get().load(uuid).then(([data, peaks, meta]) => {
                this.#cache.add({uuid, data: Option.wrap(data), info: AudioInfo.of(data), peaks, meta})
                loader.setLoaded(data, peaks, meta)
            }, fetch)
            : SampleStorage.get().loadStored(uuid).then(([pcm, peaks, meta]) => {
                const info = AudioInfo.of(pcm)
                this.#cache.add({uuid, data: Option.None, info, peaks, meta})
                loader.setStored(info, peaks, meta, Option.wrap(pcm))
            }, fetch)
        const promise = stored.catch((error: unknown) => {
            console.warn("Unexpected error loading sample:", error)
            loader.setError(error instanceof Error ? error.message : String(error))
        }).finally(() => this.#pending.removeByKey(uuid))
        this.#pending.add({uuid, promise})
    }

    async #restore(uuid: UUID.Bytes): Promise<PcmData> {
        const [audio, meta] = await this.#provider.fetch(uuid, Progress.Empty)
        const peaks = await Workers.Peak.generateAsync(Progress.Empty, SamplePeaks.findBestFit(audio.numberOfFrames),
            audio.frames, audio.numberOfFrames, audio.numberOfChannels) as ArrayBuffer
        return SampleStorage.get().store({uuid, audio, peaks, meta})
    }

    #apply(loader: DefaultSampleLoader, {data, info, peaks, meta}: CachedSample): void {
        data.match({
            some: audio => loader.setLoaded(audio, peaks, meta),
            none: () => loader.setStored(info, peaks, meta, Option.None)
        })
    }

    async #fetchFromApi(loader: DefaultSampleLoader): Promise<void> {
        const {uuid} = loader
        const [fetchProgress, peakProgress] = Progress.split(
            progress => loader.setProgress(0.1 + 0.9 * progress), 2
        )
        const fetchResult = await Promises.tryCatch(this.#provider.fetch(uuid, fetchProgress))
        if (fetchResult.status === "rejected") {
            const error = fetchResult.error
            console.warn(error)
            loader.setError(error instanceof Error ? error.message : String(error))
            return
        }
        const [audio, meta] = fetchResult.value
        const shifts = SamplePeaks.findBestFit(audio.numberOfFrames)
        const peaksBuffer = await Workers.Peak.generateAsync(
            peakProgress, shifts, audio.frames, audio.numberOfFrames, audio.numberOfChannels
        ) as ArrayBuffer
        const storeResult = await Promises.tryCatch(SampleStorage.get().store({uuid, audio, peaks: peaksBuffer, meta}))
        if (storeResult.status === "resolved") {
            const peaks = SamplePeaks.from(new ByteArrayInput(peaksBuffer))
            const info = AudioInfo.of(audio)
            if (this.#retain === "always") {
                this.#cache.add({uuid, data: Option.wrap(audio), info, peaks, meta})
                loader.setLoaded(audio, peaks, meta)
            } else {
                this.#cache.add({uuid, data: Option.None, info, peaks, meta})
                loader.setStored(info, peaks, meta, Option.wrap(storeResult.value))
            }
        } else {
            const error = storeResult.error
            console.warn(error)
            loader.setError(error instanceof Error ? error.message : String(error))
        }
    }
}