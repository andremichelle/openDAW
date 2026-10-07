// Base64 decode WITHOUT atob (not available in the AudioWorkletGlobalScope).
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const LOOKUP = new Uint8Array(256).fill(255)
for (let index = 0; index < ALPHABET.length; index++) {LOOKUP[ALPHABET.charCodeAt(index)] = index}

export const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> => {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, "")
    const output = new Uint8Array(Math.floor(clean.length * 3 / 4))
    const state = {bits: 0, count: 0, written: 0}
    for (let index = 0; index < clean.length; index++) {
        const value = LOOKUP[clean.charCodeAt(index)]
        if (value === 255) {continue}
        state.bits = (state.bits << 6) | value
        state.count += 6
        if (state.count >= 8) {
            state.count -= 8
            output[state.written++] = (state.bits >> state.count) & 0xFF
        }
    }
    return output.subarray(0, state.written).slice()
}
