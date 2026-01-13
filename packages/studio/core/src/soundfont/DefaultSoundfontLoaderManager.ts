import {Progress, SortedSet, UUID} from "@moises-ai/lib-std"
import {SoundfontLoader, SoundfontLoaderManager, SoundfontMetaData} from "@moises-ai/studio-adapters"
import {DefaultSoundfontLoader} from "./DefaultSoundfontLoader"
import {SoundfontProvider} from "./SoundfontProvider"

export class DefaultSoundfontLoaderManager implements SoundfontLoaderManager, SoundfontProvider {
    readonly #provider: SoundfontProvider
    readonly #loaders: SortedSet<UUID.Bytes, SoundfontLoader>

    constructor(provider: SoundfontProvider) {
        this.#provider = provider
        this.#loaders = UUID.newSet(loader => loader.uuid)
    }

    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[ArrayBuffer, SoundfontMetaData]> {
        return this.#provider.fetch(uuid, progress)
    }

    remove(uuid: UUID.Bytes) {this.#loaders.removeByKey(uuid)}

    getOrCreate(uuid: UUID.Bytes): SoundfontLoader {
        return this.#loaders.getOrCreate(uuid, uuid => new DefaultSoundfontLoader(this, uuid))
    }

    invalidate(uuid: UUID.Bytes) {this.#loaders.opt(uuid).ifSome(loader => loader.invalidate())}
}