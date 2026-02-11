import {Peaks} from "@opendaw/lib-fusion"
import {EngineToClient, SoundfontLoader, SoundfontLoaderManager, SoundfontLoaderState} from "@opendaw/studio-adapters"
import {Observer, Option, SortedSet, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import type {SoundFont2} from "soundfont2"

class SoundfontLoaderWorklet implements SoundfontLoader {
    readonly peaks: Option<Peaks> = Option.None
    readonly #state: SoundfontLoaderState = {type: "idle"}

    #soundfont: Option<SoundFont2> = Option.None

    constructor(readonly uuid: UUID.Bytes, readonly engineToClient: EngineToClient) {
        engineToClient.fetchSoundfont(uuid).then(data => this.#soundfont = Option.wrap(data), console.warn)
    }

    get soundfont(): Option<SoundFont2> {return this.#soundfont}
    get state(): SoundfontLoaderState {return this.#state}

    subscribe(_observer: Observer<SoundfontLoaderState>): Subscription {return Terminable.Empty}
    invalidate(): void {}

    toString(): string {return `{SoundfontLoaderWorklet}`}
}

export class SoundfontManagerWorklet implements SoundfontLoaderManager {
    readonly #engineToClient: EngineToClient
    readonly #set: SortedSet<UUID.Bytes, SoundfontLoader>

    constructor(engineToClient: EngineToClient) {
        this.#engineToClient = engineToClient
        this.#set = UUID.newSet<SoundfontLoader>(handler => handler.uuid)
    }

    getOrCreate(uuid: UUID.Bytes): SoundfontLoader {
        return this.#set.getOrCreate(uuid, uuid => new SoundfontLoaderWorklet(uuid, this.#engineToClient))
    }

    remove(_uuid: UUID.Bytes) {}
    invalidate(_uuid: UUID.Bytes) {}
}