import {Notifier, Observer, Option, Progress, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {SoundfontLoader, SoundfontLoaderState, SoundfontMetaData} from "@opendaw/studio-adapters"
import {DefaultSoundfontLoaderManager} from "./DefaultSoundfontLoaderManager"
import {SoundfontStorage} from "./SoundfontStorage"
import type {SoundFont2} from "soundfont2"
import {ExternalLib} from "../ExternalLib"

export class DefaultSoundfontLoader implements SoundfontLoader {
    readonly #manager: DefaultSoundfontLoaderManager

    readonly #uuid: UUID.Bytes
    readonly #notifier: Notifier<SoundfontLoaderState>

    #meta: Option<SoundfontMetaData> = Option.None
    #soundfont: Option<SoundFont2> = Option.None
    #state: SoundfontLoaderState = {type: "progress", progress: 0.0}

    constructor(manager: DefaultSoundfontLoaderManager, uuid: UUID.Bytes) {
        this.#manager = manager
        this.#uuid = uuid

        this.#notifier = new Notifier<SoundfontLoaderState>()
        this.#get()
    }

    subscribe(observer: Observer<SoundfontLoaderState>): Subscription {
        if (this.#state.type === "loaded") {
            observer(this.#state)
            return Terminable.Empty
        }
        return this.#notifier.subscribe(observer)
    }

    invalidate(): void {
        this.#state = {type: "progress", progress: 0.0}
        this.#meta = Option.None
        this.#soundfont = Option.None
        this.#get()
    }

    get uuid(): UUID.Bytes {return this.#uuid}
    get soundfont(): Option<SoundFont2> {return this.#soundfont}
    get meta(): Option<SoundfontMetaData> {return this.#meta}
    get state(): SoundfontLoaderState {return this.#state}

    toString(): string {return `{MainThreadSoundfontLoader}`}

    #setState(value: SoundfontLoaderState): void {
        this.#state = value
        this.#notifier.notify(this.#state)
    }

    #get(): void {
        SoundfontStorage.get().load(this.#uuid).then(async ([file, meta]) => {
                const {status, value: SoundFont2, error} = await ExternalLib.SoundFont2()
                if (status === "rejected") return console.warn(error)
                this.#soundfont = Option.wrap(new SoundFont2(new Uint8Array(file)))
                this.#meta = Option.wrap(meta)
                this.#setState({type: "loaded"})
            },
            (error: any) => {
                if (error instanceof Error && error.message.startsWith("timeoout")) {
                    this.#setState({type: "error", reason: error.message})
                    return console.warn(`Soundfont ${UUID.toString(this.#uuid)} timed out.`)
                } else {
                    return this.#fetch()
                }
            })
    }

    async #fetch(): Promise<void> {
        const fetchProgress: Progress.Handler = progress => this.#setState({type: "progress", progress})
        const fetchResult = await Promises.tryCatch(this.#manager.fetch(this.#uuid, fetchProgress))
        if (fetchResult.status === "rejected") {
            const error = fetchResult.error
            console.warn(error)
            const reason = error instanceof Error ? error.message : String(error)
            this.#setState({type: "error", reason})
            return
        }
        const [file, meta] = fetchResult.value
        const storeResult = await Promises.tryCatch(SoundfontStorage.get().save({uuid: this.#uuid, file, meta}))
        if (storeResult.status === "resolved") {
            const {status, value: SoundFont2, error} = await ExternalLib.SoundFont2()
            if (status === "rejected") return console.warn(error)
            this.#soundfont = Option.wrap(new SoundFont2(new Uint8Array(file)))
            this.#meta = Option.wrap(meta)
            this.#setState({type: "loaded"})
        } else {
            const error = storeResult.error
            console.warn(error)
            const reason = error instanceof Error ? error.message : String(error)
            this.#setState({type: "error", reason})
        }
    }
}