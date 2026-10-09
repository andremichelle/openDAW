// Decode UTF-8 bytes WITHOUT TextDecoder: the AudioWorkletGlobalScope provides neither TextDecoder nor
// TextEncoder (see worklet-scope.ts), so constructing one anywhere worklet-reachable kills the module
// before `registerProcessor` runs. Shared by every worklet host that reads a string out of wasm memory
// (panic messages, MIDI device ids). Any malformed, overlong, surrogate or truncated sequence decodes as U+FFFD,
// so the result is always well-formed UTF-16 (a lone surrogate would diverge the engine's box-graph mirror).
export const decodeUtf8 = (bytes: Uint8Array): string => {
    let result = ""
    let index = 0
    while (index < bytes.length) {
        const lead = bytes[index++] ?? 0
        const count = lead < 0x80 ? 0 : lead < 0xC2 ? -1 : lead < 0xE0 ? 1 : lead < 0xF0 ? 2 : lead < 0xF5 ? 3 : -1
        if (count <= 0) {
            result += count === 0 ? String.fromCharCode(lead) : "�"
            continue
        }
        let codePoint = lead & (0x3F >> count)
        let consumed = 0
        while (consumed < count && index < bytes.length && ((bytes[index] ?? 0) & 0xC0) === 0x80) {
            codePoint = (codePoint << 6) | ((bytes[index++] ?? 0) & 0x3F)
            consumed++
        }
        const valid = consumed === count && codePoint >= MIN_CODE_POINT[count]
            && (codePoint < 0xD800 || codePoint > 0xDFFF) && codePoint <= 0x10FFFF
        result += valid ? String.fromCodePoint(codePoint) : "�"
    }
    return result
}

const MIN_CODE_POINT: ReadonlyArray<number> = [0, 0x80, 0x800, 0x10000]

// Encode a string to UTF-8 bytes WITHOUT TextEncoder (same worklet constraint as above).
export const encodeUtf8 = (text: string): Uint8Array => {
    const bytes: Array<number> = []
    for (const char of text) {
        const codePoint = char.codePointAt(0) ?? 0
        if (codePoint < 0x80) {
            bytes.push(codePoint)
        } else if (codePoint < 0x800) {
            bytes.push(0xC0 | (codePoint >> 6), 0x80 | (codePoint & 0x3F))
        } else if (codePoint < 0x10000) {
            bytes.push(0xE0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3F), 0x80 | (codePoint & 0x3F))
        } else {
            bytes.push(0xF0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3F), 0x80 | ((codePoint >> 6) & 0x3F), 0x80 | (codePoint & 0x3F))
        }
    }
    return new Uint8Array(bytes)
}
