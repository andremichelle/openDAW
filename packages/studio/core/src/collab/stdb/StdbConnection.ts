import {Notifier, Optional, Terminable} from "@opendaw/lib-std"

export enum StdbConnectionState {
    Disconnected = "disconnected",
    Connecting = "connecting",
    Connected = "connected",
}

export type StdbConnectionConfig = {
    readonly endpoint: string
    readonly databaseName: string
    readonly token?: string
}

export class StdbConnection implements Terminable {
    readonly onChange = new Notifier<StdbConnectionState>()
    #state: StdbConnectionState = StdbConnectionState.Disconnected
    #identity: Optional<string> = undefined
    #token: Optional<string> = undefined
    readonly #config: StdbConnectionConfig

    constructor(config: StdbConnectionConfig) {
        this.#config = config
        this.#token = config.token
    }

    get state(): StdbConnectionState {return this.#state}
    get identity(): Optional<string> {return this.#identity}
    get token(): Optional<string> {return this.#token}
    get config(): StdbConnectionConfig {return this.#config}

    connect(): void {
        if (this.#state !== StdbConnectionState.Disconnected) {return}
        this.#setState(StdbConnectionState.Connecting)
    }

    disconnect(): void {
        if (this.#state === StdbConnectionState.Disconnected) {return}
        this.#identity = undefined
        this.#setState(StdbConnectionState.Disconnected)
    }

    simulateConnected(identity: string, token: string): void {
        this.#identity = identity
        this.#token = token
        this.#setState(StdbConnectionState.Connected)
    }

    terminate(): void {
        this.disconnect()
        this.#token = undefined
    }

    #setState(state: StdbConnectionState): void {
        this.#state = state
        this.onChange.notify(state)
    }
}
