import {ByteArrayInput, int, Progress, SortedSet, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {DefaultSampleLoader} from "./DefaultSampleLoader"
import {SampleProvider} from "./SampleProvider"
import {SampleLoader, SampleLoaderManager, SampleMetaData} from "@opendaw/studio-adapters"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleStorage} from "./SampleStorage"
import {Peaks, SamplePeaks} from "@opendaw/lib-fusion"
import {Workers} from "../Workers"
import {Promises} from "@opendaw/lib-runtime"

type CachedSample = {
    uuid: UUID.Bytes
    data: AudioData
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

export class GlobalSampleLoaderManager implements SampleLoaderManager, SampleProvider {
    readonly #provider: SampleProvider
    readonly #loaders: SortedSet<UUID.Bytes, SampleLoader>
    readonly #refCounts: SortedSet<UUID.Bytes, RefCount>
    readonly #cache: SortedSet<UUID.Bytes, CachedSample>
    readonly #pending: SortedSet<UUID.Bytes, PendingLoad>

    constructor(provider: SampleProvider) {
        this.#provider = provider
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

    isInUse(uuid: UUID.Bytes): boolean {return this.#refCounts.hasKey(uuid) || this.#pending.hasKey(uuid)}

    record(loader: SampleLoader): void {
        this.#loaders.add(loader)
    }

    getOrCreate(uuid: UUID.Bytes): SampleLoader {
        return this.#loaders.getOrCreate(uuid, uuid => {
            const loader = new DefaultSampleLoader(uuid)
            this.#load(loader)
            return loader
        })
    }

    async getAudioData(uuid: UUID.Bytes): Promise<AudioData> {
        const {promise, resolve, reject} = Promise.withResolvers<AudioData>()
        const loader = this.getOrCreate(uuid)
        let subscription: Subscription
        subscription = loader.subscribe(state => {
            if (state.type === "error") {
                queueMicrotask(() => subscription.terminate())
                reject(new Error(state.reason, {cause: state.cause}))
            } else if (loader.data.nonEmpty()) {
                queueMicrotask(() => subscription.terminate())
                resolve(loader.data.unwrap())
            }
        })
        return promise
    }

    #load(loader: DefaultSampleLoader): void {
        const {uuid} = loader
        const cached = this.#cache.opt(uuid)
        if (cached.nonEmpty()) {
            const {data, peaks, meta} = cached.unwrap()
            loader.setLoaded(data, peaks, meta)
            return
        }
        const pending = this.#pending.opt(uuid)
        if (pending.nonEmpty()) {
            pending.unwrap().promise.then(() => {
                const cached = this.#cache.opt(uuid)
                if (cached.nonEmpty()) {
                    const {data, peaks, meta} = cached.unwrap()
                    loader.setLoaded(data, peaks, meta)
                }
            })
            return
        }
        const promise = SampleStorage.get().load(uuid).then(
            ([data, peaks, meta]) => {
                this.#cache.add({uuid, data, peaks, meta})
                loader.setLoaded(data, peaks, meta)
            },
            () => this.#fetchFromApi(loader)
        ).catch((error: unknown) => {
            console.warn("Unexpected error loading sample:", error)
            loader.setError(error instanceof Error ? error.message : String(error), error)
        }).finally(() => this.#pending.opt(uuid).ifSome(entry => {
            if (entry.promise === promise) {this.#pending.removeByKey(uuid)}
        }))
        this.#pending.add({uuid, promise})
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
            loader.setError(error instanceof Error ? error.message : String(error), error)
            return
        }
        const [audio, meta] = fetchResult.value
        const shifts = SamplePeaks.findBestFit(audio.numberOfFrames)
        const peaksBuffer = await Workers.Peak.generateAsync(
            peakProgress, shifts, audio.frames, audio.numberOfFrames, audio.numberOfChannels
        ) as ArrayBuffer
        const stored = await Promises.tryCatch(SampleStorage.get().save({uuid, audio, peaks: peaksBuffer, meta}, true))
        if (stored.status === "rejected") {
            console.warn(`Sample ${UUID.toString(uuid)} plays from memory, it could not be stored`, stored.error)
        }
        const peaks = SamplePeaks.from(new ByteArrayInput(peaksBuffer))
        this.#cache.add({uuid, data: audio, peaks, meta})
        loader.setLoaded(audio, peaks, meta)
    }
}