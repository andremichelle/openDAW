import {isRecord, JSONValue, Notifier, Observer, Option, Subscription} from "@opendaw/lib-std"
import {Browser} from "./browser"
import {Keyboard} from "./keyboard"

export class MouseGesture {
    static of(input: MouseGesture.Input, modifiers?: { ctrl?: boolean, shift?: boolean, alt?: boolean }): MouseGesture {
        return new MouseGesture(input, modifiers?.ctrl, modifiers?.shift, modifiers?.alt)
    }

    static fromJSON(value: JSONValue): Option<MouseGesture> {
        if (!isRecord(value) || Array.isArray(value)) {return Option.None}
        const {input, ctrl, shift, alt} = value
        if (!MouseGesture.#isInput(input)) {return Option.None}
        if (typeof ctrl !== "boolean") {return Option.None}
        if (typeof shift !== "boolean") {return Option.None}
        if (typeof alt !== "boolean") {return Option.None}
        return Option.wrap(new MouseGesture(input, ctrl, shift, alt))
    }

    static fromWheel(event: MouseGesture.Modifiers): MouseGesture {
        return new MouseGesture("wheel", Keyboard.isControlKey(event), event.shiftKey, event.altKey)
    }

    // button 1 is the middle button
    static fromPointer(event: MouseGesture.Modifiers & Pick<PointerEvent, "button">): Option<MouseGesture> {
        if (event.button !== 1) {return Option.None}
        return Option.wrap(new MouseGesture("middle-drag", Keyboard.isControlKey(event), event.shiftKey, event.altKey))
    }

    static #isInput(value: unknown): value is MouseGesture.Input {return value === "wheel" || value === "middle-drag"}

    readonly #notifier = new Notifier<void>()

    #input: MouseGesture.Input
    #ctrl: boolean
    #shift: boolean
    #alt: boolean

    private constructor(input: MouseGesture.Input,
                        ctrl: boolean = false,
                        shift: boolean = false,
                        alt: boolean = false) {
        this.#input = input
        this.#ctrl = ctrl
        this.#shift = shift
        this.#alt = alt
    }

    get input(): MouseGesture.Input {return this.#input}
    get ctrl(): boolean {return this.#ctrl}
    get shift(): boolean {return this.#shift}
    get alt(): boolean {return this.#alt}

    equals(other: MouseGesture): boolean {
        return this.#input === other.#input
            && this.#ctrl === other.#ctrl
            && this.#shift === other.#shift
            && this.#alt === other.#alt
    }

    matches(input: MouseGesture.Input, event: MouseGesture.Modifiers): boolean {
        return this.#input === input
            && this.#ctrl === Keyboard.isControlKey(event)
            && this.#shift === event.shiftKey
            && this.#alt === event.altKey
    }

    format(): ReadonlyArray<string> {
        const isMacOS = Browser.isMacOS()
        const parts: Array<string> = []
        if (this.#shift) {parts.push(isMacOS ? "⇧" : "Shift")}
        if (this.#alt) {parts.push(isMacOS ? "⌥" : "Alt")}
        if (this.#ctrl) {parts.push(isMacOS ? "⌘" : "Ctrl")}
        parts.push(this.#input === "wheel" ? "Wheel" : "Middle Drag")
        if (isMacOS) {return parts}
        return parts.flatMap((part, index) => index === 0 ? [part] : ["+", part])
    }

    overrideWith(gesture: MouseGesture): void {
        if (this.equals(gesture)) {return}
        this.#input = gesture.#input
        this.#ctrl = gesture.#ctrl
        this.#shift = gesture.#shift
        this.#alt = gesture.#alt
        this.#notifier.notify()
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    toJSON(): JSONValue {return {input: this.#input, ctrl: this.#ctrl, shift: this.#shift, alt: this.#alt}}

    copy(): MouseGesture {return new MouseGesture(this.#input, this.#ctrl, this.#shift, this.#alt)}

    toString(): string {return `{MouseGesture ${this.format().join("")}}`}
}

export namespace MouseGesture {
    export type Input = "wheel" | "middle-drag"
    export type Modifiers = Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">
}
