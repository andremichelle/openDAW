import {Listeners, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import * as Y from "yjs"
import {ChatMessage} from "@/chat/ChatMessage"

export interface ChatServiceListener {
    onMessageAdded(message: ChatMessage): void
}

export class ChatService implements Terminable {
    readonly #terminator = new Terminator()
    readonly #chatArray: Y.Array<ChatMessage>
    readonly #name: string
    readonly #color: string
    readonly #listeners: Listeners<ChatServiceListener>

    constructor(doc: Y.Doc, name: string, color: string) {
        this.#chatArray = doc.getArray<ChatMessage>("chat")
        this.#name = name
        this.#color = color
        this.#listeners = this.#terminator.own(new Listeners<ChatServiceListener>())
        const handler = (event: Y.YArrayEvent<ChatMessage>) => {
            for (const delta of event.delta) {
                if (Array.isArray(delta.insert)) {
                    for (const message of delta.insert as ReadonlyArray<ChatMessage>) {
                        this.#listeners.proxy.onMessageAdded(message)
                    }
                }
            }
        }
        this.#chatArray.observe(handler)
        this.#terminator.own({terminate: () => this.#chatArray.unobserve(handler)})
    }

    sendMessage(text: string): void {
        const trimmed = text.trim()
        if (trimmed.length === 0) {return}
        this.#chatArray.push([{
            id: UUID.toString(UUID.generate()),
            name: this.#name,
            color: this.#color,
            text: trimmed.substring(0, 300),
            timestamp: Date.now()
        }])
    }

    messages(): ReadonlyArray<ChatMessage> {return this.#chatArray.toArray()}
    subscribe(listener: ChatServiceListener): Subscription {return this.#listeners.subscribe(listener)}

    terminate(): void {this.#terminator.terminate()}
}
