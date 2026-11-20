import {Notifier, Observer, Option, Progress, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {SoundfontBank, SoundfontLoader, SoundfontLoaderState, SoundfontMetaData} from "@opendaw/studio-adapters"
import {GlobalSoundfontLoaderManager} from "./GlobalSoundfontLoaderManager"
import {SoundfontStorage} from "./SoundfontStorage"
import {ExternalLib} from "../ExternalLib"

export class DefaultSoundfontLoader implements SoundfontLoader {
    readonly #manager: GlobalSoundfontLoaderManager

    readonly #uuid: UUID.Bytes
    readonly #notifier: Notifier<SoundfontLoaderState>

    #meta: Option<SoundfontMetaData> = Option.None
    #soundfont: Option<SoundfontBank.Bank> = Option.None
    #file: Option<ArrayBuffer> = Option.None
    #state: SoundfontLoaderState = {type: "progress", progress: 0.0}

    constructor(manager: GlobalSoundfontLoaderManager, uuid: UUID.Bytes) {
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
        this.#file = Option.None
        this.#get()
    }

    get uuid(): UUID.Bytes {return this.#uuid}
    get soundfont(): Option<SoundfontBank.Bank> {return this.#soundfont}
    get file(): Option<ArrayBuffer> {return this.#file}
    get meta(): Option<SoundfontMetaData> {return this.#meta}
    get state(): SoundfontLoaderState {return this.#state}

    toString(): string {return `{MainThreadSoundfontLoader}`}

    #setState(value: SoundfontLoaderState): void {
        this.#state = value
        this.#notifier.notify(this.#state)
    }

    #get(): void {
        SoundfontStorage.get().load(this.#uuid).then(async ([file, meta]) => {
                const {status, value: read, error} = await ExternalLib.Soundfont()
                if (status === "rejected") return console.warn(error)
                this.#soundfont = Option.wrap(read(file))
                this.#meta = Option.wrap(meta)
                this.#setState({type: "loaded"})
            },
            (error: any) => {
                if (error instanceof Error && error.message.startsWith("timeoout")) {
                    this.#setState({type: "error", reason: error.message, cause: error})
                    return console.warn(`Soundfont ${UUID.toString(this.#uuid)} timed out.`)
                } else {
                    return this.#fetch()
                }
            }).catch(error => {
            console.warn("Failed to load soundfont:", error)
            this.#setState({type: "error", reason: error instanceof Error ? error.message : String(error), cause: error})
        })
    }

    async #fetch(): Promise<void> {
        const fetchProgress: Progress.Handler = progress => this.#setState({type: "progress", progress})
        const fetchResult = await Promises.tryCatch(this.#manager.fetch(this.#uuid, fetchProgress))
        if (fetchResult.status === "rejected") {
            const error = fetchResult.error
            console.warn(error)
            const reason = error instanceof Error ? error.message : String(error)
            this.#setState({type: "error", reason, cause: error})
            return
        }
        const [file, meta] = fetchResult.value
        const stored = await Promises.tryCatch(SoundfontStorage.get().save({uuid: this.#uuid, file, meta}, true))
        if (stored.status === "rejected") {
            console.warn(`Soundfont ${UUID.toString(this.#uuid)} plays from memory, it could not be stored`, stored.error)
        }
        const {status, value: read, error} = await ExternalLib.Soundfont()
        if (status === "rejected") return console.warn(error)
        this.#soundfont = Option.wrap(read(file))
        this.#file = stored.status === "rejected" ? Option.wrap(file) : Option.None
        this.#meta = Option.wrap(meta)
        this.#setState({type: "loaded"})
    }
}