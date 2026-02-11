import {Peaks} from "@opendaw/lib-fusion"
import {EngineToClient, SampleLoader, SampleLoaderManager, SampleLoaderState} from "@opendaw/studio-adapters"
import {Observer, Option, SortedSet, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"

class SampleLoaderWorklet implements SampleLoader, Terminable {
    readonly peaks: Option<Peaks> = Option.None
    readonly #state: SampleLoaderState = {type: "idle"}

    #data: Option<AudioData> = Option.None

    constructor(readonly uuid: UUID.Bytes, readonly engineToClient: EngineToClient) {
        engineToClient.fetchAudio(uuid).then(data => this.#data = Option.wrap(data), console.warn)
    }

    get data(): Option<AudioData> {return this.#data}
    get state(): SampleLoaderState {return this.#state}

    subscribe(_observer: Observer<SampleLoaderState>): Subscription {return Terminable.Empty}
    invalidate(): void {}
    terminate(): void {this.#data = Option.None}

    toString(): string {return `{SampleLoaderWorklet}`}
}

export class SampleManagerWorklet implements SampleLoaderManager, Terminable {
    readonly #engineToClient: EngineToClient
    readonly #set: SortedSet<UUID.Bytes, SampleLoaderWorklet>

    constructor(engineToClient: EngineToClient) {
        this.#engineToClient = engineToClient
        this.#set = UUID.newSet<SampleLoaderWorklet>(({uuid}) => uuid)
    }

    record(_loader: SampleLoader): void {}
    getOrCreate(uuid: UUID.Bytes): SampleLoader {
        return this.#set.getOrCreate(uuid, uuid => new SampleLoaderWorklet(uuid, this.#engineToClient))
    }
    remove(uuid: UUID.Bytes): void {this.#set.removeByKey(uuid).terminate()}
    register(_uuid: UUID.Bytes): Terminable {return Terminable.Empty}
    invalidate(_uuid: UUID.Bytes): void {}
    terminate(): void {
        this.#set.forEach(loader => loader.terminate())
        this.#set.clear()
    }
}