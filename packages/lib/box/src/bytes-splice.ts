import {int, Option} from "@opendaw/lib-std"

/** One change of a byte value: `deleteCount` bytes at `offset` give way to `insert`. */
export type BytesSplice = {
    readonly offset: int
    readonly deleteCount: int
    readonly insert: Int8Array
}

export namespace BytesSplice {
    /** The smallest splice from `from` to `to`: their common prefix and suffix stay, the rest is replaced. None if equal. */
    export const of = (from: Readonly<Int8Array>, to: Readonly<Int8Array>): Option<BytesSplice> => {
        const shorter = Math.min(from.length, to.length)
        let prefix = 0
        while (prefix < shorter && from[prefix] === to[prefix]) {prefix++}
        if (prefix === from.length && prefix === to.length) {return Option.None}
        let suffix = 0
        while (suffix < shorter - prefix && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]) {suffix++}
        return Option.wrap({
            offset: prefix,
            deleteCount: from.length - prefix - suffix,
            insert: to.slice(prefix, to.length - suffix)
        })
    }

    /** `value` with `splice` applied, a new array. */
    export const apply = (value: Readonly<Int8Array>, {offset, deleteCount, insert}: BytesSplice): Int8Array => {
        if (offset < 0 || deleteCount < 0 || offset + deleteCount > value.length) {
            throw new RangeError(`splice ${offset}+${deleteCount} outside ${value.length} bytes`)
        }
        const result = new Int8Array(value.length - deleteCount + insert.length)
        result.set(value.subarray(0, offset))
        result.set(insert, offset)
        result.set(value.subarray(offset + deleteCount), offset + insert.length)
        return result
    }

    /** The bytes a splice moves over the wire, against the whole value. */
    export const cost = ({insert}: BytesSplice): int => insert.length + 8
}
