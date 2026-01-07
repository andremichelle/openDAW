import {int, Notifier, Procedure} from "@opendaw/lib-std"
import {Browser} from "@opendaw/lib-dom"

export class UserCounter {
    readonly #sessionId: string
    readonly #apiUrl: string
    readonly #notifier: Notifier<int> = new Notifier()

    constructor(apiUrl: string) {
        this.#sessionId = Browser.id()
        this.#apiUrl = apiUrl
        this.#sendHeartbeat().finally()
    }

    subscribe(observer: Procedure<int>) {return this.#notifier.subscribe(observer)}

    async #sendHeartbeat(): Promise<void> {
        try {
            const response = await fetch(this.#apiUrl, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({sessionId: this.#sessionId})
            })
            const data = await response.json()
            this.#notifier.notify(data.count)
        } catch (error) {
            console.warn("Failed to send heartbeat:", error)
        } finally {
            setTimeout(() => this.#sendHeartbeat(), 60000)
        }
    }
}