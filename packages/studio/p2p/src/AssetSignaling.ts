import {Notifier, Observer, Subscription, Terminable} from "@opendaw/lib-std"

export type SignalingMessage = {
    readonly type: string
    readonly topic: string
    readonly [key: string]: unknown
}

export interface SignalingSocket {
    send(data: string): void
    close(): void
    onmessage: ((event: {data: string}) => void) | null
    onclose: (() => void) | null
    onerror: ((error: unknown) => void) | null
}

export class AssetSignaling implements Terminable {
    readonly #socket: SignalingSocket
    readonly #topic: string
    readonly #notifier: Notifier<SignalingMessage> = new Notifier<SignalingMessage>()
    #terminated: boolean = false

    constructor(socket: SignalingSocket, topic: string) {
        this.#socket = socket
        this.#topic = topic
        this.#socket.onmessage = (event: {data: string}) => this.#onMessage(event.data)
        this.#socket.onclose = () => this.terminate()
        this.#socket.onerror = () => this.terminate()
        this.#subscribe()
    }

    get topic(): string {return this.#topic}

    subscribe(observer: Observer<SignalingMessage>): Subscription {
        return this.#notifier.subscribe(observer)
    }

    publish(message: Omit<SignalingMessage, "topic">): void {
        if (this.#terminated) {return}
        this.#send({...message, topic: this.#topic})
    }

    terminate(): void {
        if (this.#terminated) {return}
        this.#terminated = true
        this.#unsubscribe()
        this.#socket.onmessage = null
        this.#socket.onclose = null
        this.#socket.onerror = null
        this.#socket.close()
    }

    #subscribe(): void {
        this.#send({type: "subscribe", topics: [this.#topic]})
    }

    #unsubscribe(): void {
        this.#send({type: "unsubscribe", topics: [this.#topic]})
    }

    #send(message: Record<string, unknown>): void {
        this.#socket.send(JSON.stringify(message))
    }

    #onMessage(data: string): void {
        try {
            const message = JSON.parse(data)
            if (message.topic === this.#topic) {
                this.#notifier.notify(message as SignalingMessage)
            }
        } catch (_error: unknown) {
            // ignore malformed messages
        }
    }
}
