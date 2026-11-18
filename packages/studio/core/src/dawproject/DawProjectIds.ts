import {int, isDefined, Option, tryCatch, UUID} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"

// an element standing for a box or field carries its address, so an openDAW export keeps its identities
export class DawProjectIds {
    static readonly Pattern = /^_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})((?:\.-?\d+)*)$/

    static toAddress(id: string): Option<Address> {
        const match = DawProjectIds.Pattern.exec(id)
        if (!isDefined(match)) {return Option.None}
        const parsed = tryCatch(() => UUID.parse(match[1]))
        if (parsed.status === "failure") {return Option.None}
        const keys = match[2].split(".").filter(key => key.length > 0).map(Number)
        return Option.wrap(Address.compose(parsed.value, ...keys))
    }

    static fromAddress(address: Address): string {
        return `_${UUID.toString(address.uuid)}${Array.from(address.fieldKeys, key => `.${key}`).join("")}`
    }

    readonly #used = new Set<string>()

    #counter: int = 0

    of(address: Address): string {
        const id = DawProjectIds.fromAddress(address)
        this.#used.add(id)
        return id
    }

    next(): string {
        const id = `id${this.#counter++}`
        this.#used.add(id)
        return id
    }

    has(id: string): boolean {return this.#used.has(id)}
}
