import {
    isDefined,
    Notifier,
    Nullable,
    Observable,
    Observer,
    Procedure,
    Subscription,
    Terminable
} from "@moises-ai/lib-std"

export type Port = {
    postMessage(message: any, transfer?: Array<Transferable>): void
    onmessage: Nullable<Procedure<MessageEvent>>
    onmessageerror: Nullable<Procedure<MessageEvent>>
}

export const Messenger = {for: (port: Port): Messenger => new NativeMessenger(port)}

export type Messenger = Observable<any> & Terminable & {
    send(message: any, transfer?: Array<Transferable>): void
    channel(name: string): Messenger
}

const EmptyTransferables: Array<Transferable> = []

class NativeMessenger implements Messenger {
    readonly #port: Port
    readonly #notifier = new Notifier<any>()

    constructor(port: Port) {
        this.#port = port

        if (isDefined(port.onmessage) || isDefined(port.onmessageerror)) {
            console.error(port)
            throw new Error(`${port} is already wrapped.`)
        }
        port.onmessage = (event: MessageEvent) => this.#notifier.notify(event.data)
        port.onmessageerror = (event: MessageEvent) => {throw new Error(event.type)}
    }

    send(message: any, transfer?: Array<Transferable>): void {
        this.#port.postMessage(message, transfer ?? EmptyTransferables)
    }

    channel(name: string): Messenger {return new Channel(this, name)}
    subscribe(observer: Observer<MessageEvent>): Subscription {return this.#notifier.subscribe(observer)}
    terminate(): void {
        this.#notifier.terminate()
        this.#port.onmessage = null
        this.#port.onmessageerror = null
    }
}

// with '__id__' we put in a little security that we are only communicating with the messenger we created
class Channel implements Messenger {
    readonly #messages: Messenger
    readonly #name: string
    readonly #notifier = new Notifier<any>()
    readonly #subscription: Subscription

    constructor(messages: Messenger, name: string) {
        this.#messages = messages
        this.#name = name
        this.#subscription = messages.subscribe(data => {
            if ("__id__" in data && data.__id__ === "42" && "message" in data && "channel" in data && data.channel === name) {
                this.#notifier.notify(data.message)
            }
        })
    }

    send(message: any, transferrables?: Array<Transferable>): void {
        this.#messages.send({__id__: "42", channel: this.#name, message}, transferrables)
    }

    channel(name: string): Messenger {return new Channel(this, name)}
    subscribe(observer: Observer<MessageEvent>): Subscription {return this.#notifier.subscribe(observer)}
    terminate(): void {
        this.#subscription.terminate()
        this.#notifier.terminate()
    }
}