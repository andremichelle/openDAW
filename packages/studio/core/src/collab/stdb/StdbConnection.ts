import {isDefined, Notifier, Optional, Terminable} from "@opendaw/lib-std"

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

const TOKEN_STORAGE_KEY = "opendaw-stdb-token"

function tryGetSessionStorage(key: string): Optional<string> {
    try {
        return globalThis.sessionStorage?.getItem(key) ?? undefined
    } catch {
        return undefined
    }
}

function trySetSessionStorage(key: string, value: string): void {
    try {
        globalThis.sessionStorage?.setItem(key, value)
    } catch { /* noop in test env */ }
}

export class StdbConnection implements Terminable {
    readonly onChange = new Notifier<StdbConnectionState>()
    #state: StdbConnectionState = StdbConnectionState.Disconnected
    #identity: Optional<string> = undefined
    #token: Optional<string> = undefined
    #sdkConnection: Optional<{disconnect(): void}> = undefined
    #rawSdkConnection: Optional<unknown> = undefined
    readonly #config: StdbConnectionConfig

    constructor(config: StdbConnectionConfig) {
        this.#config = config
        this.#token = config.token
    }

    get state(): StdbConnectionState {return this.#state}
    get identity(): Optional<string> {return this.#identity}
    get token(): Optional<string> {return this.#token}
    get config(): StdbConnectionConfig {return this.#config}
    get sdk(): Optional<unknown> {return this.#rawSdkConnection}

    connect(): void {
        if (this.#state !== StdbConnectionState.Disconnected) {return}
        this.#setState(StdbConnectionState.Connecting)
        this.#connectSdk()
    }

    disconnect(): void {
        if (this.#state === StdbConnectionState.Disconnected) {return}
        if (isDefined(this.#sdkConnection)) {
            this.#sdkConnection.disconnect()
        }
        this.#identity = undefined
        this.#sdkConnection = undefined
        this.#rawSdkConnection = undefined
        this.#setState(StdbConnectionState.Disconnected)
    }

    simulateConnected(identity: string, token: string): void {
        this.#identity = identity
        this.#token = token
        this.#setState(StdbConnectionState.Connected)
    }

    callReducer(name: string, argsBuffer: Uint8Array): void {
        if (this.#state !== StdbConnectionState.Connected) {return}
        const conn = this.#sdkConnection as Optional<{callReducer(name: string, args: Uint8Array, flags: string): void}>
        if (isDefined(conn) && typeof conn.callReducer === "function") {
            conn.callReducer(name, argsBuffer, "FullUpdate")
        }
    }

    terminate(): void {
        this.disconnect()
        this.#token = undefined
    }

    #setState(state: StdbConnectionState): void {
        this.#state = state
        this.onChange.notify(state)
    }

    async #connectSdk(): Promise<void> {
        const savedToken = this.#token ?? tryGetSessionStorage(TOKEN_STORAGE_KEY)
        try {
            console.debug("[StdbConnection] importing module_bindings...")
            const {DbConnection} = await import("./module_bindings")
            console.debug("[StdbConnection] building connection to", this.#config.endpoint, this.#config.databaseName)
            let builder = DbConnection.builder()
                .withUri(this.#config.endpoint)
                .withDatabaseName(this.#config.databaseName)
            if (isDefined(savedToken)) {
                console.debug("[StdbConnection] using saved token")
                builder = builder.withToken(savedToken)
            }
            const conn = builder
                .onConnect((_connection: unknown, identity: {toHexString?: () => string}, token: string) => {
                    console.debug("[StdbConnection] onConnect fired!", identity, token?.substring(0, 20))
                    const identityHex = typeof identity?.toHexString === "function"
                        ? identity.toHexString()
                        : String(identity)
                    this.#identity = identityHex
                    this.#token = token
                    trySetSessionStorage(TOKEN_STORAGE_KEY, token)
                    this.#setState(StdbConnectionState.Connected)
                })
                .onConnectError((_ctx: unknown, error: Error) => {
                    console.error("[StdbConnection] onConnectError:", error)
                    this.#token = undefined
                    try { globalThis.sessionStorage?.removeItem(TOKEN_STORAGE_KEY) } catch { /* noop */ }
                    this.#sdkConnection = undefined
                    this.#identity = undefined
                    this.#setState(StdbConnectionState.Disconnected)
                })
                .onDisconnect((...args: Array<unknown>) => {
                    console.debug("[StdbConnection] onDisconnect fired!", args)
                    this.#sdkConnection = undefined
                    this.#rawSdkConnection = undefined
                    this.#identity = undefined
                    this.#setState(StdbConnectionState.Disconnected)
                })
                .build()
            console.debug("[StdbConnection] build() returned, connection object:", typeof conn)
            this.#sdkConnection = conn as {disconnect(): void}
            this.#rawSdkConnection = conn
        } catch (error: unknown) {
            console.error("[StdbConnection] #connectSdk error:", error)
            this.#setState(StdbConnectionState.Disconnected)
        }
    }
}
