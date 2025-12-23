import {BinarySearch, NumberComparator, Subscription} from "@opendaw/lib-std"
import {Browser} from "./browser"
import {Events} from "./events"
import {Keyboard} from "./keyboard"

export class ShortcutDef {
    static of(code: string, modifiers?: { ctrl?: boolean, shift?: boolean, alt?: boolean }): ShortcutDef {
        return new ShortcutDef(code, modifiers?.ctrl, modifiers?.shift, modifiers?.alt)
    }

    static #formatKey(code: string): string {
        if (code.startsWith("Key")) return code.slice(3)
        if (code.startsWith("Digit")) return code.slice(5)
        if (code === "Space") return Browser.isMacOS() ? "␣" : "Space"
        if (code === "Escape") return Browser.isMacOS() ? "⎋" : "Esc"
        if (code === "Enter") return Browser.isMacOS() ? "↩" : "Enter"
        if (code === "Backspace") return Browser.isMacOS() ? "⌫" : "Backspace"
        if (code === "Delete") return Browser.isMacOS() ? "⌦" : "Del"
        if (code === "ArrowUp") return "↑"
        if (code === "ArrowDown") return "↓"
        if (code === "ArrowLeft") return "←"
        if (code === "ArrowRight") return "→"
        return code
    }

    private constructor(readonly code: string,
                        readonly ctrl: boolean = false,
                        readonly shift: boolean = false,
                        readonly alt: boolean = false) {}

    matches(event: KeyboardEvent): boolean {
        return event.code === this.code
            && this.ctrl === Keyboard.isControlKey(event)
            && this.shift === event.shiftKey
            && this.alt === event.altKey
    }

    format(): string {
        const parts: Array<string> = []
        if (this.ctrl) {parts.push(Browser.isMacOS() ? "⌘" : "Ctrl")}
        if (this.shift) {parts.push(Browser.isMacOS() ? "⇧" : "Shift")}
        if (this.alt) {parts.push(Browser.isMacOS() ? "⌥" : "Alt")}
        parts.push(ShortcutDef.#formatKey(this.code))
        return parts.join(Browser.isMacOS() ? "" : "+")
    }
}

export class ShortcutOptions {
    private constructor(readonly preventDefault: boolean = true,
                        readonly allowRepeat: boolean = false,
                        readonly activeInTextField: boolean = false,
                        readonly priority: number = 0) {}

    static Default = new ShortcutOptions()

    static of(options?: {
        preventDefault?: boolean
        allowRepeat?: boolean
        activeInTextField?: boolean
        priority?: number
    }): ShortcutOptions {
        if (options === undefined) return ShortcutOptions.Default
        return new ShortcutOptions(options.preventDefault ?? true,
            options.allowRepeat ?? false,
            options.activeInTextField ?? false,
            options.priority ?? 0)
    }
}

class ShortcutEntry {
    constructor(readonly def: ShortcutDef,
                readonly action: () => void,
                readonly options: ShortcutOptions) {}
}

export class ShortcutManager {
    readonly #shortcuts: Array<ShortcutEntry> = []

    register(def: ShortcutDef, action: () => void, options?: ShortcutOptions): Subscription {
        const entry = new ShortcutEntry(def, action, options ?? ShortcutOptions.Default)
        const index = BinarySearch.leftMostMapped(
            this.#shortcuts, entry.options.priority, NumberComparator, ({options: {priority}}) => priority)
        this.#shortcuts.splice(index, 0, entry)
        return {terminate: () => this.#shortcuts.splice(this.#shortcuts.indexOf(entry), 1)}
    }

    handleEvent(event: KeyboardEvent): void {
        for (const {def, action, options} of this.#shortcuts) {
            if (!options.activeInTextField && Events.isTextInput(event.target)) {continue}
            if (!options.allowRepeat && event.repeat) {continue}
            if (!def.matches(event)) {continue}
            if (options.preventDefault) event.preventDefault()
            action()
            return
        }
    }
}