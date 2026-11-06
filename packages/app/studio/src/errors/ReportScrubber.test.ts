import {describe, expect, it} from "vitest"
import {ReportScrubber} from "./ReportScrubber"

describe("ReportScrubber.scrubber", () => {
    it("blanks every name, the longest first, and keeps the rest of the text", () => {
        const scrub = ReportScrubber.scrubber(["My Song (final)", "My Song", "kick.wav"])
        expect(scrub(`Loaded 'My Song (final)' with kick.wav, then My Song`))
            .toBe("Loaded '<name>' with <name>, then <name>")
    })

    it("treats regex characters in names literally", () => {
        const scrub = ReportScrubber.scrubber(["a+b*[c]"])
        expect(scrub("x a+b*[c] y aab")).toBe("x <name> y aab")
    })

    it("leaves the text alone without names", () => {
        expect(ReportScrubber.scrubber([])("nothing to hide")).toBe("nothing to hide")
    })
})
