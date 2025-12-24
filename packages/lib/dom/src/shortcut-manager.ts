import {
    BinarySearch,
    isAbsent,
    JSONValue,
    Lazy,
    Maybe,
    NumberComparator,
    Option,
    Predicate,
    Predicates,
    Provider,
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

    readonly global: ShortcutContext

    readonly #contexts: Array<ShortcutContext> = []

    private constructor() {
        this.global = this.createContext(Predicates.alwaysTrue, "Global")
        console.debug("ShortcutManager installed")
    }

    createContext(activation: Predicate<void> | Element, name: string): ShortcutContext {
        const isActive = typeof activation === "function"
            ? activation :
            () => activation.contains(document.activeElement)
        const context = new ShortcutContext(isActive, name)
        this.#contexts.unshift(context)
        return context
    }

    hasConflict(keys: Shortcut): boolean {
        return this.#contexts.some(context => context.hasConflict(keys))
    }

    handleEvent(event: KeyboardEvent): void {
        for (const context of this.#contexts) {
            if (context.active && this.#tryHandle(event, context)) {
                console.debug("consumed by", context.name)
                return
            }
        }
    }

    #tryHandle(event: KeyboardEvent, context: ShortcutContext): boolean {
        for (const {shortcut, consume, options} of context.shortcuts) {
            if (!options.activeInTextField && Events.isTextInput(event.target)) {continue}
            if (!options.allowRepeat && event.repeat) {continue}
            if (!shortcut.matches(event)) {continue}
            if (options.preventDefault ?? true) {event.preventDefault()}
            const returnValue: unknown = consume()
            return returnValue !== false // everything counts as consumed unless one specifically returns false
        }
        return false
    }
}

export class ShortcutContext implements Terminable {
    readonly #isActive: Predicate<void>
    readonly #name: string
    readonly #shortcuts: Array<ShortcutEntry> = []
    readonly #terminator: Terminator = new Terminator()

    constructor(isActive: Predicate<void>, name: string) {
        this.#isActive = isActive
        this.#name = name
    }

    get active(): boolean {return this.#isActive()}
    get name(): string {return this.#name}
    get shortcuts(): ReadonlyArray<ShortcutEntry> {return this.#shortcuts}

    register(shortcut: Shortcut, consume: Provider<Maybe<boolean> | unknown>, options?: ShortcutOptions): Subscription {
        const entry: ShortcutEntry = {shortcut, consume, options: options ?? ShortcutOptions.Default}
        const index = BinarySearch.leftMostMapped(
            this.#shortcuts, entry.options.priority ?? 0, NumberComparator, ({options: {priority}}) => priority ?? 0)
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

export type ShortcutOptions = {
    readonly preventDefault?: boolean
    readonly allowRepeat?: boolean
    readonly activeInTextField?: boolean
    readonly priority?: number
}

export namespace ShortcutOptions {
    export const Default: ShortcutOptions = {
        preventDefault: true,
        allowRepeat: false,
        activeInTextField: false,
        priority: 0
    }
}

type ShortcutEntry = {
    readonly shortcut: Shortcut
    readonly consume: Provider<Maybe<boolean> | unknown>
    readonly options: ShortcutOptions
}