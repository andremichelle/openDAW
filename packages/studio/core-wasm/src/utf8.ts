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
