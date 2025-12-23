import {
    BinarySearch,
    Exec,
    isAbsent,
    JSONValue,
    Lazy,
    NumberComparator,
    Option,
    Predicate,
    Predicates,
    Subscription,
    Terminable,
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

    hasConflict(keys: Shortcut): boolean {
        if (this.global.hasConflict(keys)) {return true}
        return this.#contexts.some(ctx => ctx.hasConflict(keys))
    }

    handleEvent(event: KeyboardEvent): void {
        for (const context of this.#contexts) {
            if (context.active && this.#tryHandle(event, context)) {return}
        }
        if (this.#tryHandle(event, this.global)) {return}
    }

    #tryHandle(event: KeyboardEvent, context: ShortcutContext): boolean {
        for (const {shortcut, action, options} of context.shortcuts) {
            if (!options.activeInTextField && Events.isTextInput(event.target)) {continue}
            if (!options.allowRepeat && event.repeat) {continue}
            if (!shortcut.matches(event)) {continue}
            if (options.preventDefault) {event.preventDefault()}
            action()
            return true
        }
        return false
    }
}

export class ShortcutContext implements Terminable {
    readonly #isActive: Predicate<void>
    readonly #shortcuts: Array<ShortcutEntry> = []
    readonly #terminator: Terminator = new Terminator()

    constructor(isActive: Predicate<void>) {
        this.#isActive = isActive
    }

    get active(): boolean {return this.#isActive()}
    get shortcuts(): ReadonlyArray<ShortcutEntry> {return this.#shortcuts}

    register(shortcut: Shortcut, action: Exec, options?: ShortcutOptions): Subscription {
        const entry: ShortcutEntry = {shortcut, action, options: options ?? ShortcutOptions.Default}
        const index = BinarySearch.leftMostMapped(
            this.#shortcuts, entry.options.priority, NumberComparator, ({options: {priority}}) => priority)
        this.#shortcuts.splice(index, 0, entry)
        return this.#terminator.own({terminate: () => this.#shortcuts.splice(this.#shortcuts.indexOf(entry), 1)})
    }

    hasConflict(keys: Shortcut): boolean {
        return this.#shortcuts.some(entry => entry.shortcut.equals(keys))
    }

    terminate(): void {this.#terminator.terminate()}
}

export class Shortcut {
    static of(code: string, modifiers?: { ctrl?: boolean, shift?: boolean, alt?: boolean }): Shortcut {
        return new Shortcut(code, modifiers?.ctrl, modifiers?.shift, modifiers?.alt)
    }

    static fromJSON(value: JSONValue): Option<Shortcut> {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {return Option.None}
        const {code, ctrl, shift, alt} = value as Record<string, unknown>
        if (typeof code !== "string") {return Option.None}
        if (typeof ctrl !== "boolean") {return Option.None}
        if (typeof shift !== "boolean") {return Option.None}
        if (typeof alt !== "boolean") {return Option.None}
        return Option.wrap(new Shortcut(code, ctrl, shift, alt))
    }

    static fromEvent(event: KeyboardEvent): Option<Shortcut> {
        const code = event.code
        if (code.startsWith("Shift")
            || code.startsWith("Control")
            || code.startsWith("Alt")
            || code.startsWith("Meta")
            || code === Key.Escape
            || code === Key.Delete
            || code === Key.Backspace
            || code === Key.Enter
        ) {
            return Option.None
        }
        return Option.wrap(new Shortcut(code, Keyboard.isControlKey(event), event.shiftKey, event.altKey))
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

    equals(other: Shortcut): boolean {
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
        parts.push(Shortcut.#formatKey(this.#code))
        return parts.join(Browser.isMacOS() ? "" : "+")
    }

    overrideWith(shortcut: Shortcut): void {
        this.#code = shortcut.#code
        this.#ctrl = shortcut.#ctrl
        this.#shift = shortcut.#shift
        this.#alt = shortcut.#alt
    }

    toJSON(): JSONValue {return {code: this.#code, ctrl: this.#ctrl, shift: this.#shift, alt: this.#alt}}

    copy(): Shortcut {return new Shortcut(this.#code, this.#ctrl, this.#shift, this.#alt)}

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
    readonly shortcut: Shortcut
    readonly action: Exec
    readonly options: ShortcutOptions
}