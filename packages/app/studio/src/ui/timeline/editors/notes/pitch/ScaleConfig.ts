import {MidiKeys} from "@moises-ai/lib-dsp"
import {byte, int, JSONValue, Notifier, Observer, Subscription, Terminable} from "@moises-ai/lib-std"

export class ScaleConfig implements MidiKeys.Scale, Terminable {
    static readonly EMPTY = 0b111111111111

    readonly #notifier: Notifier<ScaleConfig>

    #bits: int = ScaleConfig.EMPTY
    #key: byte = 0

    constructor() {this.#notifier = new Notifier<ScaleConfig>()}

    set key(value: byte) {
        if (this.#key === value) {return}
        this.#key = value
        this.#notifier.notify(this)
    }
    get key(): byte {return this.#key}
    get bits(): int {return this.#bits}

    toJSON(): JSONValue {
        return {key: this.#key, bits: this.#bits}
    }

    fromJSON(json: JSONValue): void {
        if (json !== null && typeof json === "object" && "key" in json && "bits" in json) {
            this.#key = json.key as byte
            this.#bits = json.bits as int
        }
    }

    reset(): void {this.setBits(ScaleConfig.EMPTY)}
    isEmpty(): boolean {return this.#bits === ScaleConfig.EMPTY}

    subscribe(observer: Observer<ScaleConfig>): Subscription {return this.#notifier.subscribe(observer)}
    toggle(index: int): void {this.setBit(index, !this.getBit(index))}
    setScale(template: MidiKeys.Scale): void {
        if (template.equals(this)) {return}
        this.#bits = template.bits
        this.#notifier.notify(this)
    }
    setBits(value: int): void {
        if (this.#bits === value) {return}
        this.#bits = value
        this.#notifier.notify(this)
    }
    setBit(index: int, value: boolean): void {
        const byte = 1 << index
        this.setBits(value ? this.#bits | byte : this.#bits & ~byte)
    }
    getBit(index: int): boolean {return (this.#bits & (1 << index)) !== 0}
    has(note: int): boolean {return this.getBit((note - this.#key + 12) % 12)}
    equals(other: MidiKeys.Scale): boolean {return this.#bits === other.bits}
    terminate(): void {this.#notifier.terminate()}
}