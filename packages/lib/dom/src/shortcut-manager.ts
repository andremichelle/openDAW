import {
    Arrays,
    BinarySearch,
    int,
    isAbsent,
    JSONValue,
    Lazy,
    Maybe,
    Notifier,
    NumberComparator,
    Observer,
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

    createContext(activation: Predicate<void> | Element, name: string, priority?: int): ShortcutContext {
        const isActive = typeof activation === "function"
            ? activation :
            () => activation.contains(document.activeElement)
        const context = new ShortcutContext(isActive, name, priority ?? 0)
        const index = BinarySearch.leftMostMapped(
            this.#contexts, context.priority, (a, b) => b - a, ({priority}) => priority)
        this.#contexts.splice(index, 0, context)
        console.debug(this.#contexts.map(({name, priority}) => `${name} (${priority})`).join(", "))
        context.own(Terminable.create(() => Arrays.remove(this.#contexts, context)))
        return context
    }

    hasConflict(shortcut: Shortcut): boolean {
        return this.#contexts.some(context => context.hasConflict(shortcut))
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
        for (const {shortcut, consume, options} of context.entries) {
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
    readonly #terminator: Terminator = new Terminator()
    readonly #isActive: Predicate<void>
    readonly #name: string
    readonly #priority: int
    readonly #entries: Array<ShortcutEntry> = []

    constructor(isActive: Predicate<void>, name: string, priority: int) {
        this.#isActive = isActive
        this.#name = name
        this.#priority = priority
    }

    get active(): boolean {return this.#isActive()}
    get name(): string {return this.#name}
    get priority(): int {return this.#priority}
    get entries(): ReadonlyArray<ShortcutEntry> {return this.#entries}

    register(shortcut: Shortcut, consume: Provider<Maybe<boolean> | unknown>, options?: ShortcutOptions): Subscription {
        if (ReservedShortcuts.isReserved(shortcut)) {
            console.warn(`Shortcut ${shortcut.format().join("")} is reserved and cannot be overridden`)
            return Terminable.Empty
        }
        const entry: ShortcutEntry = {shortcut, consume, options: options ?? ShortcutOptions.Default}
        const index = BinarySearch.leftMostMapped(
            this.#entries, entry.options.priority ?? 0, NumberComparator, ({options: {priority}}) => priority ?? 0)
        this.#entries.splice(index, 0, entry)
        return this.#terminator.own({terminate: () => this.#entries.splice(this.#entries.indexOf(entry), 1)})
    }

    hasConflict(shortcut: Shortcut): boolean {return this.#entries.some(entry => entry.shortcut.equals(shortcut))}

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own(terminable)}

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
        if (Events.isAutofillEvent(event)) {return Option.None}
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
        // For letters, use event.key to get the layout-independent character
        const effectiveCode = code.startsWith("Key")
            ? `Key${event.key.toUpperCase()}`
            : code
        const shortcut = new Shortcut(effectiveCode, Keyboard.isControlKey(event), event.shiftKey, event.altKey)
        if (ReservedShortcuts.isReserved(shortcut)) {return Option.None}
        return Option.wrap(shortcut)
    }

    static readonly #keyNames: Record<string, string | [mac: string, other: string]> = {
        [Key.Escape]: ["⎋", "Esc"],
        [Key.Enter]: ["↩", "Enter"],
        [Key.Backspace]: ["⌫", "Backspace"],
        [Key.Delete]: ["⌦", "Del"],
        [Key.DeleteAction]: ["⌫", "Del"],
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

    readonly #notifier = new Notifier<void>()

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
        if (Events.isAutofillEvent(event)) {return false}
        let codeMatches: boolean
        if (this.#code.startsWith("Key")) {
            // For letters, use event.key to respect keyboard layout (e.g. QWERTZ)
            const expectedLetter = this.#code.slice(3).toLowerCase()
            codeMatches = event.key.toLowerCase() === expectedLetter
        } else {
            codeMatches = event.code === this.#code
                || (this.#code === Key.DeleteAction && Keyboard.isDelete(event))
        }
        return codeMatches
            && this.#ctrl === Keyboard.isControlKey(event)
            && this.#shift === event.shiftKey
            && this.#alt === event.altKey
    }

    format(): ReadonlyArray<string> {
        const parts: Array<string> = []
        if (this.#shift) {parts.push(Browser.isMacOS() ? "⇧" : "Shift")}
        if (this.#alt) {parts.push(Browser.isMacOS() ? "⌥" : "Alt")}
        if (this.#ctrl) {parts.push(Browser.isMacOS() ? "⌘" : "Ctrl")}
        parts.push(Shortcut.#formatKey(this.#code))
        if (!Browser.isMacOS()) {
            const result: Array<string> = []
            for (let i = 0; i < parts.length; i++) {
                if (i > 0) {result.push("+")}
                result.push(parts[i])
            }
            return result
        }
        return parts
    }

    overrideWith(shortcut: Shortcut): void {
        if (this.#code === shortcut.#code
            && this.#ctrl === shortcut.#ctrl
            && this.#shift === shortcut.#shift
            && this.#alt === shortcut.#alt) {return}
        this.#code = shortcut.#code
        this.#ctrl = shortcut.#ctrl
        this.#shift = shortcut.#shift
        this.#alt = shortcut.#alt
        this.#notifier.notify()
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    toJSON(): JSONValue {return {code: this.#code, ctrl: this.#ctrl, shift: this.#shift, alt: this.#alt}}

    copy(): Shortcut {return new Shortcut(this.#code, this.#ctrl, this.#shift, this.#alt)}

    toString(): string {return `{ShortcutKeys ${this.format().join("")}}`}
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

export namespace ReservedShortcuts {
    export const Copy = Shortcut.of(Key.KeyC, {ctrl: true})
    export const Cut = Shortcut.of(Key.KeyX, {ctrl: true})
    export const Paste = Shortcut.of(Key.KeyV, {ctrl: true})

    const all: ReadonlyArray<Shortcut> = [Copy, Cut, Paste]

    export const isReserved = (shortcut: Shortcut): boolean => all.some(reserved => reserved.equals(shortcut))
}