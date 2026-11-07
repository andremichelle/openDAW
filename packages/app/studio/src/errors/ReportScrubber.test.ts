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

    it("blanks whole words only, never parts of other words", () => {
        const scrub = ReportScrubber.scrubber(["cut", "Bass", "Revamp"])
        expect(scrub("ShortcutManager installed, cut the Bass, RevampDeviceBox:aaa1ed58 Revamp_2 Bass2"))
            .toBe("ShortcutManager installed, <name> the <name>, RevampDeviceBox:aaa1ed58 Revamp_2 Bass2")
    })

    it("treats letters of any script as word characters", () => {
        const scrub = ReportScrubber.scrubber(["Müll", "ドラム"])
        expect(scrub("Müller Müll ドラムス ドラム")).toBe("Müller <name> ドラムス <name>")
    })

    it("blanks names that start or end with punctuation", () => {
        const scrub = ReportScrubber.scrubber(["(final)", "#1 Hit"])
        expect(scrub("song (final), #1 Hit!")).toBe("song <name>, <name>!")
    })

    it("leaves the text alone without names", () => {
        expect(ReportScrubber.scrubber([])("nothing to hide")).toBe("nothing to hide")
    })
})
