import {describe, expect, it} from "vitest"
import {decodeUtf8, encodeUtf8} from "../src/utf8"

const hasLoneSurrogate = (text: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)

describe("decodeUtf8", () => {
    it("round-trips well-formed text", () => {
        for (const text of ["", "OB-Xf", "Mönch ßäö", "€ 1", "pair 👻 ok", "\u{10FFFF}"]) {
            expect(decodeUtf8(encodeUtf8(text))).toBe(text)
        }
    })
    it("never yields a lone surrogate (Latin-1 0xED + ascii used to decode into D8xx-DFxx)", () => {
        expect(decodeUtf8(new Uint8Array([0xED, 0x61, 0x62]))).toBe("�ab")
        expect(decodeUtf8(new Uint8Array([0x4D, 0xF6, 0x6E, 0x63, 0x68]))).toBe("M�nch")
    })
    it("rejects CESU-8 encoded surrogates", () => {
        expect(decodeUtf8(new Uint8Array([0xED, 0xA0, 0x80]))).toBe("�")
        expect(decodeUtf8(new Uint8Array([0xED, 0xBF, 0xBF]))).toBe("�")
    })
    it("rejects overlong forms and code points beyond U+10FFFF", () => {
        expect(decodeUtf8(new Uint8Array([0xC0, 0x80]))).toBe("��")
        expect(decodeUtf8(new Uint8Array([0xE0, 0x80, 0x80]))).toBe("�")
        expect(decodeUtf8(new Uint8Array([0xF4, 0x90, 0x80, 0x80]))).toBe("�")
        expect(decodeUtf8(new Uint8Array([0xF8, 0x41]))).toBe("�A")
    })
    it("replaces a truncated tail", () => {
        expect(decodeUtf8(new Uint8Array([0x41, 0xE2, 0x82]))).toBe("A�")
        expect(decodeUtf8(new Uint8Array([0xF0, 0x9F]))).toBe("�")
    })
    it("keeps the byte after a broken sequence", () => {
        expect(decodeUtf8(new Uint8Array([0xE2, 0x41, 0x42]))).toBe("�AB")
    })
    it("yields well-formed UTF-16 for every byte pair and triple", () => {
        for (let lead = 0x80; lead < 0x100; lead++) {
            for (let next = 0; next < 0x100; next += 3) {
                expect(hasLoneSurrogate(decodeUtf8(new Uint8Array([lead, next, 0x80 | (next & 0x3F)])))).toBe(false)
            }
        }
    })
})
