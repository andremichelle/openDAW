// Decode UTF-8 bytes WITHOUT TextDecoder: the AudioWorkletGlobalScope provides neither TextDecoder nor
// TextEncoder (see worklet-scope.ts), so constructing one anywhere worklet-reachable kills the module
// before `registerProcessor` runs. Shared by every worklet host that reads a string out of wasm memory
// (panic messages, MIDI device ids). Malformed sequences decode as U+FFFD; a truncated tail reads zeros.
export const decodeUtf8 = (bytes: Uint8Array): string => {
    let result = ""
    let index = 0
    const next = (): number => (bytes[index++] ?? 0) & 0x3F
    while (index < bytes.length) {
        const byte0 = bytes[index++] ?? 0
        const codePoint = byte0 < 0x80 ? byte0
            : (byte0 & 0xE0) === 0xC0 ? ((byte0 & 0x1F) << 6) | next()
                : (byte0 & 0xF0) === 0xE0 ? ((byte0 & 0x0F) << 12) | (next() << 6) | next()
                    : (byte0 & 0xF8) === 0xF0 ? ((byte0 & 0x07) << 18) | (next() << 12) | (next() << 6) | next()
                        : 0xFFFD
        result += codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : "�"
    }
    return result
}

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
