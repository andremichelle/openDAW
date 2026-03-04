import {Notifier, Terminable} from "@opendaw/lib-std"
import {PresenceData} from "./types"

export class PresenceService implements Terminable {
    readonly #participants: Map<string, PresenceData> = new Map()
    readonly onChange: Notifier<void> = new Notifier()

    get participants(): ReadonlyArray<PresenceData> {
        return Array.from(this.#participants.values())
    }

    updatePresence(data: PresenceData): void {
        this.#participants.set(data.identity, data)
        this.onChange.notify()
    }

    removeParticipant(identity: string): void {
        if (!this.#participants.has(identity)) {return}
        this.#participants.delete(identity)
        this.onChange.notify()
    }

    terminate(): void {
        this.#participants.clear()
        this.onChange.terminate()
    }
}
