import {
    BinarySearch,
    Exec,
    isAbsent,
    Lazy,
    NumberComparator,
    Option,
    Predicate,
    Predicates,
    Subscription,
    Terminator
} from "@opendaw/lib-std"
import {Browser} from "./browser"
import {Events} from "./events"
import {Key} from "./key"
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

    hasConflicts(): ReadonlyArray<ShortcutKeys> {
        const conflicts: Array<ShortcutKeys> = []
        for (let i = 0; i < this.#shortcuts.length; i++) {
            const keys = this.#shortcuts[i].keys
            if (conflicts.some(other => other.equals(keys))) {continue}
            for (let j = i + 1; j < this.#shortcuts.length; j++) {
                if (keys.equals(this.#shortcuts[j].keys)) {
                    conflicts.push(keys)
                    break
                }
            }
        }
        return conflicts
    }

    terminate(): void {this.#terminator.terminate()}
}

export class ShortcutKeys {
    static of(code: string, modifiers?: { ctrl?: boolean, shift?: boolean, alt?: boolean }): ShortcutKeys {
        return new ShortcutKeys(code, modifiers?.ctrl, modifiers?.shift, modifiers?.alt)
    }

    static fromEvent(event: KeyboardEvent): Option<ShortcutKeys> {
        const code = event.code
        if (code.startsWith("Shift")
            || code.startsWith("Control")
            || code.startsWith("Alt")
            || code.startsWith("Meta")) {
            return Option.None
        }
        return Option.wrap(new ShortcutKeys(code, Keyboard.isControlKey(event), event.shiftKey, event.altKey))
    }

    static readonly #keyNames: Record<string, string | [mac: string, other: string]> = {
        [Key.Escape]: ["⎋", "Esc"],
        [Key.Enter]: ["↩", "Enter"],
        [Key.Backspace]: ["⌫", "Backspace"],
        [Key.Delete]: ["⌦", "Del"],
        [Key.Home]: ["↖", "Home"],
        [Key.End]: ["↘", "End"],
        [Key.PageUp]: ["⇞", "PgUp"],
        [Key.PageDown]: ["⇟", "PgDn"],
        [Key.ArrowUp]: "↑",
        [Key.ArrowDown]: "↓",
        [Key.ArrowLeft]: "←",
        [Key.ArrowRight]: "→",
        [Key.Comma]: ",",
        [Key.Period]: ".",
        [Key.Semicolon]: ";",
        [Key.Quote]: "'",
        [Key.Backquote]: "`",
        [Key.Slash]: "/",
        [Key.Backslash]: "\\",
        [Key.BracketLeft]: "[",
        [Key.BracketRight]: "]",
        [Key.Minus]: "-",
        [Key.Equal]: "="
    }

    static #formatKey(code: string): string {
        if (code.startsWith("Key")) {return code.slice(3)}
        if (code.startsWith("Digit")) {return `#${code.slice(5)}`}
        const mapped = this.#keyNames[code]
        if (isAbsent(mapped)) {return code}
        if (typeof mapped === "string") {return mapped}
        return Browser.isMacOS() ? mapped[0] : mapped[1]
    }

    #code: string
    #ctrl: boolean
    #shift: boolean
    #alt: boolean

    private constructor(code: string, ctrl: boolean = false, shift: boolean = false, alt: boolean = false) {
        this.#code = code
        this.#ctrl = ctrl
        this.#shift = shift
        this.#alt = alt
    }

    get code(): string {return this.#code}
    get ctrl(): boolean {return this.#ctrl}
    get shift(): boolean {return this.#shift}
    get alt(): boolean {return this.#alt}

    equals(other: ShortcutKeys): boolean {
        return this.#code === other.#code
            && this.#ctrl === other.#ctrl
            && this.#shift === other.#shift
            && this.#alt === other.#alt
    }

    matches(event: KeyboardEvent): boolean {
        return event.code === this.#code
            && this.#ctrl === Keyboard.isControlKey(event)
            && this.#shift === event.shiftKey
            && this.#alt === event.altKey
    }

    format(): string {
        const parts: Array<string> = []
        if (this.#shift) {parts.push(Browser.isMacOS() ? "⇧" : "Shift")}
        if (this.#alt) {parts.push(Browser.isMacOS() ? "⌥" : "Alt")}
        if (this.#ctrl) {parts.push(Browser.isMacOS() ? "⌘" : "Ctrl")}
        parts.push(ShortcutKeys.#formatKey(this.#code))
        return parts.join(Browser.isMacOS() ? "" : "+")
    }

    overrideWith(keys: ShortcutKeys): void {
        this.#code = keys.#code
        this.#ctrl = keys.#ctrl
        this.#shift = keys.#shift
        this.#alt = keys.#alt
    }

    toString(): string {return `{ShortcutKeys ${this.format()}}`}
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