import {DefaultObservableValue, MutableObservableValue, Nullable, Terminable, Terminator} from "@opendaw/lib-std"
import {deferNextFrame} from "@opendaw/lib-dom"
import type {Awareness} from "y-protocols/awareness"

const StorageKeyName = "opendaw:user:name"
const StorageKeyColor = "opendaw:user:color"

const UserColors: ReadonlyArray<string> = [
    "#E06C75", "#61AFEF", "#98C379", "#E5C07B", "#C678DD",
    "#56B6C2", "#BE5046", "#D19A66", "#ABB2BF", "#FF79C6"
]

export type AwarenessUserState = {
    name: string
    color: string
    panel: Nullable<string>
}

export const readIdentity = (): { name: string, color: string } => {
    const name = localStorage.getItem(StorageKeyName) ?? ""
    let color = localStorage.getItem(StorageKeyColor)
    if (color === null) {
        const bytes = new Uint8Array(1)
        crypto.getRandomValues(bytes)
        color = UserColors[bytes[0] % UserColors.length]
        localStorage.setItem(StorageKeyColor, color)
    }
    return {name, color}
}

export const writeIdentity = (name: string, color: string): void => {
    localStorage.setItem(StorageKeyName, name)
    localStorage.setItem(StorageKeyColor, color)
}

export const userColors = (): ReadonlyArray<string> => UserColors

export class RoomAwareness implements Terminable {
    readonly #terminator = new Terminator()
    readonly #awareness: Awareness

    readonly #name: DefaultObservableValue<string>
    readonly #color: DefaultObservableValue<string>
    readonly #panel: DefaultObservableValue<Nullable<string>>

    readonly #roomName: string

    constructor(awareness: Awareness, roomName: string, name: string, color: string) {
        this.#awareness = awareness
        this.#roomName = roomName
        this.#name = this.#terminator.own(new DefaultObservableValue<string>(name))
        this.#color = this.#terminator.own(new DefaultObservableValue<string>(color))
        this.#panel = this.#terminator.own(new DefaultObservableValue<Nullable<string>>(null))

        const broadcast = this.#terminator.own(deferNextFrame(() => {
            const name = this.#name.getValue()
            const color = this.#color.getValue()
            const panel = this.#panel.getValue()
            this.#awareness.setLocalStateField("user", {name, color, panel})
            writeIdentity(name, color)
        }))
        this.#terminator.own(this.#name.subscribe(broadcast.request))
        this.#terminator.own(this.#color.subscribe(broadcast.request))
        this.#terminator.own(this.#panel.subscribe(broadcast.request))
        broadcast.request()
    }

    get name(): MutableObservableValue<string> {return this.#name}
    get color(): MutableObservableValue<string> {return this.#color}
    get panel(): MutableObservableValue<Nullable<string>> {return this.#panel}
    get roomName(): string {return this.#roomName}
    get awareness(): Awareness {return this.#awareness}
    get clientID(): number {return this.#awareness.clientID}

    terminate(): void {this.#terminator.terminate()}
}
