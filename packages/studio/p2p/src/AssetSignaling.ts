import {Notifier, Observer, Subscription, Terminable} from "@opendaw/lib-std"

export type SignalingMessage = {
    readonly type: string
    readonly topic: string
    readonly [key: string]: unknown
}

export interface SignalingSocket {
    send(data: string): void
    close(): void
    readonly readyState: number
    onopen: ((event: unknown) => void) | null
    onmessage: ((event: {readonly data: string}) => void) | null
    onclose: ((event: unknown) => void) | null
    onerror: ((event: unknown) => void) | null
}

export class AssetSignaling implements Terminable {
    readonly #socket: SignalingSocket
    readonly #topic: string
    readonly #notifier: Notifier<SignalingMessage> = new Notifier<SignalingMessage>()
    readonly #pending: Array<Record<string, unknown>> = []
    #connected: boolean = false
    #terminated: boolean = false

    constructor(socket: SignalingSocket, topic: string) {
        this.#socket = socket
        this.#topic = topic
        this.#socket.onopen = () => {
            console.debug("[P2P:Signaling] connected to", topic)
            this.#connected = true
            this.#flush()
        }
        this.#socket.onmessage = (event: {data: string}) => this.#onMessage(event.data)
        this.#socket.onclose = () => {
            console.debug("[P2P:Signaling] socket closed")
            this.terminate()
        }
        this.#socket.onerror = () => {
            console.debug("[P2P:Signaling] socket error")
            this.terminate()
        }
        if (socket.readyState === 1) {
            this.#connected = true
        }
        this.#subscribe()
    }

    get topic(): string {return this.#topic}

    subscribe(observer: Observer<SignalingMessage>): Subscription {
        return this.#notifier.subscribe(observer)
    }

    publish(message: Omit<SignalingMessage, "topic">): void {
        if (this.#terminated) {return}
        this.#send({type: "publish", topic: this.#topic, data: message})
    }

    terminate(): void {
        if (this.#terminated) {return}
        this.#terminated = true
        this.#unsubscribe()
        this.#socket.onopen = null
        this.#socket.onmessage = null
        this.#socket.onclose = null
        this.#socket.onerror = null
        this.#socket.close()
    }

    #subscribe(): void {
        this.#send({type: "subscribe", topics: [this.#topic]})
    }

    #unsubscribe(): void {
        if (this.#connected) {
            this.#socket.send(JSON.stringify({type: "unsubscribe", topics: [this.#topic]}))
        }
    }

    #send(message: Record<string, unknown>): void {
        if (this.#connected) {
            console.debug("[P2P:Signaling] sending:", message.type ?? message.topics)
            this.#socket.send(JSON.stringify(message))
        } else {
            console.debug("[P2P:Signaling] queuing (not connected):", message.type ?? message.topics)
            this.#pending.push(message)
        }
    }

    #flush(): void {
        console.debug("[P2P:Signaling] flushing", this.#pending.length, "queued messages")
        for (const message of this.#pending) {
            this.#socket.send(JSON.stringify(message))
        }
        this.#pending.length = 0
    }

    #onMessage(raw: string): void {
        try {
            const envelope = JSON.parse(raw)
            if (envelope.topic !== this.#topic) {return}
            const message = envelope.data as SignalingMessage
            console.debug("[P2P:Signaling] received:", message.type, "from", message.peerId)
            this.#notifier.notify(message)
        } catch (_error: unknown) {
            console.debug("[P2P:Signaling] malformed message:", raw)
        }
    }
}
