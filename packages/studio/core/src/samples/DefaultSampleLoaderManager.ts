import {Progress, SortedSet, Subscription, UUID} from "@opendaw/lib-std"
import {DefaultSampleLoader} from "./DefaultSampleLoader"
import {SampleProvider} from "./SampleProvider"
import {SampleLoader, SampleLoaderManager, SampleMetaData} from "@opendaw/studio-adapters"
import {AudioData} from "@opendaw/lib-dsp"

export class DefaultSampleLoaderManager implements SampleLoaderManager, SampleProvider {
    readonly #provider: SampleProvider
    readonly #loaders: SortedSet<UUID.Bytes, SampleLoader>

    constructor(provider: SampleProvider) {
        this.#provider = provider
        this.#loaders = UUID.newSet(loader => loader.uuid)
    }

    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]> {
        return this.#provider.fetch(uuid, progress)
    }

    remove(uuid: UUID.Bytes) {this.#loaders.removeByKey(uuid)}
    invalidate(uuid: UUID.Bytes) {this.#loaders.opt(uuid).ifSome(loader => loader.invalidate())}

    record(loader: SampleLoader): void {this.#loaders.add(loader)}

    getOrCreate(uuid: UUID.Bytes): SampleLoader {
        return this.#loaders.getOrCreate(uuid, uuid => new DefaultSampleLoader(this, uuid))
    }

    async getAudioData(uuid: UUID.Bytes): Promise<AudioData> {
        const {promise, resolve, reject} = Promise.withResolvers<AudioData>()
        const loader = this.getOrCreate(uuid)
        let subscription: Subscription
        subscription = loader.subscribe(state => {
            if (state.type === "error") {
                queueMicrotask(() => subscription.terminate())
                reject(new Error(state.reason))
            } else if (loader.data.nonEmpty()) {
                queueMicrotask(() => subscription.terminate())
                resolve(loader.data.unwrap())
            }
        })
        return promise
    }
}