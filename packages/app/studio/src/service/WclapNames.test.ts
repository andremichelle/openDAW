import {describe, expect, it} from "vitest"
import {WclapNames} from "./WclapNames"

describe("WclapNames.distinct", () => {
    it("strips a shared bracket tag", () => {
        expect(WclapNames.distinct(["[Basics] Reverb", "[Basics] Chorus", "[Basics] Crunch"]))
            .toEqual(["Reverb", "Chorus", "Crunch"])
    })
    it("cuts at a word boundary, never inside a word", () => {
        expect(WclapNames.distinct(["Basics Chorus", "Basics Crunch"])).toEqual(["Chorus", "Crunch"])
        expect(WclapNames.distinct(["Chorus", "Crunch"])).toEqual(["Chorus", "Crunch"])
    })
    it("strips separators after the shared part", () => {
        expect(WclapNames.distinct(["Suite - Delay", "Suite - Drive"])).toEqual(["Delay", "Drive"])
    })
    it("keeps a single name and names without a shared word", () => {
        expect(WclapNames.distinct(["[Basics] Reverb"])).toEqual(["[Basics] Reverb"])
        expect(WclapNames.distinct(["Tapa", "MNO"])).toEqual(["Tapa", "MNO"])
    })
    it("keeps all names when one would become empty", () => {
        expect(WclapNames.distinct(["Synth", "Synth Pro"])).toEqual(["Synth", "Synth Pro"])
        expect(WclapNames.distinct(["Synth -", "Synth - Pro"])).toEqual(["Synth -", "Synth - Pro"])
    })
})
