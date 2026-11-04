import {Func, isDefined, Nullable, Procedure, Terminable, tryCatch} from "@opendaw/lib-std"
import {isObject} from "@/call/CallTypes"

const KeepAliveMs = 20_000
const ReconnectMs = 2_000

export class RoomSignaling<T> implements Terminable {
    readonly #url: string
    readonly #topic: string
    readonly #parse: Func<unknown, Nullable<T>>
    readonly #onSignal: Procedure<T>
    readonly #onReconnect: Procedure<void>
    readonly #pending: Array<string> = []
    readonly #ready: PromiseWithResolvers<void> = Promise.withResolvers<void>()

    #socket: Nullable<WebSocket> = null
    #keepAlive: Nullable<ReturnType<typeof setInterval>> = null
    #reconnect: Nullable<ReturnType<typeof setTimeout>> = null
    #everConnected: boolean = false
    #terminated: boolean = false

    constructor(url: string, topic: string, parse: Func<unknown, Nullable<T>>, onSignal: Procedure<T>,
                onReconnect: Procedure<void>) {
        this.#url = url
        this.#topic = topic
        this.#parse = parse
        this.#onSignal = onSignal
        this.#onReconnect = onReconnect
        this.#connect()
    }

    ready(): Promise<void> {return this.#ready.promise}

    publish(signal: T): void {
        if (this.#terminated) {return}
        const raw = JSON.stringify({type: "publish", topic: this.#topic, data: signal})
        if (isDefined(this.#socket) && this.#socket.readyState === WebSocket.OPEN) {
            this.#socket.send(raw)
        } else {
            this.#pending.push(raw)
        }
    }

    terminate(): void {
        if (this.#terminated) {return}
        this.#terminated = true
        this.#clearTimers()
        if (isDefined(this.#socket)) {
            const socket = this.#socket
            this.#socket = null
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({type: "unsubscribe", topics: [this.#topic]}))
            }
            socket.close()
        }
    }

    #connect(): void {
        const socket = new WebSocket(this.#url)
        this.#socket = socket
        socket.onopen = () => {
            socket.send(JSON.stringify({type: "subscribe", topics: [this.#topic]}))
            this.#pending.splice(0).forEach(raw => socket.send(raw))
            this.#keepAlive = setInterval(() => socket.send(JSON.stringify({type: "ping"})), KeepAliveMs)
            if (this.#everConnected) {this.#onReconnect()}
            this.#ready.resolve()
            this.#everConnected = true
        }
        socket.onmessage = (event: MessageEvent) => {
            if (typeof event.data !== "string") {return}
            const result = tryCatch(() => JSON.parse(event.data))
            if (result.status === "failure") {return}
            const envelope: Partial<Record<string, unknown>> = isObject(result.value) ? result.value : {}
            if (envelope.topic !== this.#topic) {return}
            const signal = this.#parse(envelope.data)
            if (isDefined(signal)) {this.#onSignal(signal)}
        }
        socket.onclose = () => {
            this.#clearTimers()
            if (this.#terminated) {return}
            this.#reconnect = setTimeout(() => this.#connect(), ReconnectMs)
        }
        socket.onerror = () => socket.close()
    }

    #clearTimers(): void {
        if (isDefined(this.#keepAlive)) {clearInterval(this.#keepAlive)}
        if (isDefined(this.#reconnect)) {clearTimeout(this.#reconnect)}
        this.#keepAlive = null
        this.#reconnect = null
    }
}
