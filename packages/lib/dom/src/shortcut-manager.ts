import {
    BinarySearch,
    Exec,
    isAbsent,
    Lazy,
    NumberComparator,
    Predicate,
    Predicates,
    Subscription,
    Terminator
} from "@opendaw/lib-std"
import {Browser} from "./browser"
import {Events} from "./events"
import {Keyboard} from "./keyboard"

export class ShortcutManager {
    @Lazy
    static get(): ShortcutManager {return new ShortcutManager()}

    readonly global: ShortcutContext = new ShortcutContext(Predicates.alwaysTrue)

    readonly #contexts: Array<ShortcutContext> = []

    private constructor() {console.debug("ShortcutManager installed")}

    createContext(isActive: Predicate<void>): ShortcutContext {
        const context = new ShortcutContext(isActive)
        this.#contexts.push(context)
        return context
    }

    removeContext(context: ShortcutContext): void {
        const index = this.#contexts.indexOf(context)
        if (index !== -1) {
            context.terminate()
            this.#contexts.splice(index, 1)
        }
    }

    hasConflict(keys: ShortcutKeys): boolean {
        if (this.global.hasConflict(keys)) {return true}
        return this.#contexts.some(ctx => ctx.hasConflict(keys))
    }

    handleEvent(event: KeyboardEvent): void {
        if (this.#tryHandle(event, this.global)) {return}
        for (const context of this.#contexts) {
            if (context.active && this.#tryHandle(event, context)) {return}
        }
    }

    #tryHandle(event: KeyboardEvent, context: ShortcutContext): boolean {
        for (const {keys, action, options} of context.shortcuts) {
            if (!options.activeInTextField && Events.isTextInput(event.target)) {continue}
            if (!options.allowRepeat && event.repeat) {continue}
            if (!keys.matches(event)) {continue}
            if (options.preventDefault) {event.preventDefault()}
            action()
            return true
        }
        return false
    }
}

export class ShortcutContext {
    readonly #isActive: Predicate<void>
    readonly #shortcuts: Array<ShortcutEntry> = []
    readonly #terminator: Terminator = new Terminator()

    constructor(isActive: Predicate<void>) {
        this.#isActive = isActive
    }

    get active(): boolean {return this.#isActive()}
    get shortcuts(): ReadonlyArray<ShortcutEntry> {return this.#shortcuts}

    register(keys: ShortcutKeys, action: Exec, options?: ShortcutOptions): Subscription {
        const entry: ShortcutEntry = {keys: keys, action, options: options ?? ShortcutOptions.Default}
        const index = BinarySearch.leftMostMapped(
            this.#shortcuts, entry.options.priority, NumberComparator, ({options: {priority}}) => priority)
        this.#shortcuts.splice(index, 0, entry)
        return this.#terminator.own({terminate: () => this.#shortcuts.splice(this.#shortcuts.indexOf(entry), 1)})
    }

    hasConflict(keys: ShortcutKeys): boolean {
        return this.#shortcuts.some(entry => entry.keys.equals(keys))
    }

    terminate(): void {this.#terminator.terminate()}
}

export class ShortcutKeys {
    static of(code: string, modifiers?: { ctrl?: boolean, shift?: boolean, alt?: boolean }): ShortcutKeys {
        return new ShortcutKeys(code, modifiers?.ctrl, modifiers?.shift, modifiers?.alt)
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

    equals(other: ShortcutKeys): boolean {
        return this.code === other.code
            && this.ctrl === other.ctrl
            && this.shift === other.shift
            && this.alt === other.alt
    }

    matches(event: KeyboardEvent): boolean {
        return event.code === this.code
            && this.ctrl === Keyboard.isControlKey(event)
            && this.shift === event.shiftKey
            && this.alt === event.altKey
    }

    format(): string {
        const parts: Array<string> = []
        if (this.shift) {parts.push(Browser.isMacOS() ? "⇧" : "Shift")}
        if (this.alt) {parts.push(Browser.isMacOS() ? "⌥" : "Alt")}
        if (this.ctrl) {parts.push(Browser.isMacOS() ? "⌘" : "Ctrl")}
        parts.push(ShortcutKeys.#formatKey(this.code))
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
        if (isAbsent(options)) return ShortcutOptions.Default
        return new ShortcutOptions(options.preventDefault ?? true,
            options.allowRepeat ?? false,
            options.activeInTextField ?? false,
            options.priority ?? 0)
    }
}

type ShortcutEntry = {
    readonly keys: ShortcutKeys
    readonly action: Exec
    readonly options: ShortcutOptions
}