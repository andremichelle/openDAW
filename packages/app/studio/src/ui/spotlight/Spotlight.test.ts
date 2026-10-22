import {describe, expect, it} from "vitest"
import {EmptyExec, Nullable, Option} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {SpotlightVerb, SpotlightVerbs} from "./SpotlightVerbs"
import {SpotlightEntry} from "./SpotlightEntry"

type Construct = {
    names: ReadonlyArray<string>
    qualifiers?: ReadonlyArray<string>
    group?: number
    disabled?: Option<string>
    verb?: SpotlightVerb
    children?: ReadonlyArray<SpotlightEntry>
}

const entry = (label: string, {names, qualifiers = [], group = 0, disabled = Option.None, verb = "create", children = []}: Construct)
    : SpotlightEntry => ({verb, label, names, qualifiers, icon: IconSymbol.Add, detail: "", group, disabled, children, run: EmptyExec})

const labels = (entries: ReadonlyArray<SpotlightEntry>, subject: string, verb: Option<SpotlightVerb> = Option.None) =>
    SpotlightEntry.rank(entries, verb, subject).map(({label}) => label)

const verbOf = (text: string): Nullable<SpotlightVerb> => SpotlightVerbs.parse(text).verb.map(({verb}) => verb).unwrapOrNull()

describe("SpotlightVerbs.parse", () => {
    it("has no verb unless one is typed", () => {
        const query = SpotlightVerbs.parse("vapo")
        expect(query.verb.isEmpty()).toBe(true)
        expect(query.subject).toBe("vapo")
    })
    it("takes a symbol without a space", () => {
        expect(verbOf("+vapo")).toBe("create")
        expect(verbOf("-delay")).toBe("remove")
        expect(verbOf("@ vapo")).toBe("goto")
        expect(verbOf("go mixer")).toBe("goto")
        expect(verbOf(">vapo")).toBe("move")
        expect(verbOf("=bpm")).toBe("edit")
        expect(verbOf("/bundle")).toBe("open")
        expect(verbOf("op stems")).toBe("open")
        expect(SpotlightVerbs.parse("+vapo").subject).toBe("vapo")
        expect(SpotlightVerbs.parse("@ vapo").subject).toBe("vapo")
    })
    it("takes the full word or a unique prefix followed by a space", () => {
        expect(verbOf("create delay")).toBe("create")
        expect(verbOf("rem delay")).toBe("remove")
        expect(verbOf("m  vapo ")).toBe("move")
        expect(SpotlightVerbs.parse("m  vapo ").subject).toBe("vapo")
    })
    it("treats a first word that is no verb as the subject", () => {
        expect(verbOf("fade in")).toBeNull()
        expect(SpotlightVerbs.parse("fade in").subject).toBe("fade in")
        expect(verbOf("delay tape")).toBeNull()
    })
    it("offers a completion for a unique verb prefix still being typed", () => {
        expect(SpotlightVerbs.parse("cr").completion.unwrapOrNull()).toBe("create ")
        expect(SpotlightVerbs.parse("remove").completion.unwrapOrNull()).toBe("remove ")
        expect(SpotlightVerbs.parse("vapo").completion.isEmpty()).toBe(true)
        expect(SpotlightVerbs.parse("").completion.isEmpty()).toBe(true)
        expect(SpotlightVerbs.parse("cr vapo").completion.isEmpty()).toBe(true)
    })
    it("ignores leading whitespace", () => {
        expect(verbOf("  +vapo")).toBe("create")
        expect(SpotlightVerbs.parse("  +vapo").subject).toBe("vapo")
    })
})

describe("SpotlightEntry.rank", () => {
    const brightPad = entry("Create Vaporisateur · Bright Pad", {names: ["Bright Pad"], qualifiers: ["Vaporisateur"], group: 1})
    const darkPad = entry("Create Vaporisateur · Dark Pad", {names: ["Dark Pad"], qualifiers: ["Vaporisateur"], group: 2})
    const vaporisateur = entry("Create Vaporisateur", {names: ["Vaporisateur", "Analog Synth"], children: [brightPad, darkPad]})
    const delayTape = entry("Create Delay · Tape", {names: ["Tape"], qualifiers: ["Delay"], group: 1})
    const tapeDelay = entry("Create Delay · Tape Delay", {names: ["Tape Delay"], qualifiers: ["Delay"], group: 2})
    const delay = entry("Create Delay", {names: ["Delay"], children: [delayTape, tapeDelay]})
    const fadeIn = entry("Create Apparat with Fade In script", {names: ["Fade In"], qualifiers: ["Apparat", "volume"], group: 3})
    const all = [brightPad, darkPad, vaporisateur, delay, delayTape, tapeDelay, fadeIn]

    it("lists nothing for an empty subject", () => {
        expect(labels(all, "")).toEqual([])
        expect(labels(all, "   ")).toEqual([])
    })
    it("lists only the device for its name, not its presets", () => {
        expect(labels(all, "vapo")).toEqual(["Create Vaporisateur"])
        expect(labels(all, "delay")).toEqual(["Create Delay", "Create Delay · Tape Delay"])
    })
    it("lists presets by their own name across devices", () => {
        expect(labels(all, "pad")).toEqual(["Create Vaporisateur · Bright Pad", "Create Vaporisateur · Dark Pad"])
        expect(labels(all, "tape")).toEqual(["Create Delay · Tape", "Create Delay · Tape Delay"])
    })
    it("narrows presets by their device name", () => {
        expect(labels(all, "vapo bright")).toEqual(["Create Vaporisateur · Bright Pad"])
        expect(labels(all, "bri vap")).toEqual(["Create Vaporisateur · Bright Pad"])
        expect(labels(all, "delay pad")).toEqual([])
        expect(labels(all, "bright x")).toEqual([])
    })
    it("never lists an entry by its qualifiers alone", () => {
        expect(labels(all, "apparat")).toEqual([])
        expect(labels(all, "volume")).toEqual([])
        expect(labels(all, "fade volume")).toEqual(["Create Apparat with Fade In script"])
    })
    it("matches a device by its description", () => {
        expect(labels(all, "synth")).toEqual(["Create Vaporisateur"])
    })
    it("ranks exact words first, then more words hitting the name, then by group", () => {
        expect(labels(all, "tape delay")).toEqual(["Create Delay · Tape Delay", "Create Delay · Tape"])
        expect(labels(all, "tape del")).toEqual(["Create Delay · Tape Delay", "Create Delay · Tape"])
        expect(labels(all, "tape")).toEqual(["Create Delay · Tape", "Create Delay · Tape Delay"])
    })
    it("matches names typed without their spaces", () => {
        expect(labels(all, "fadein")).toEqual(["Create Apparat with Fade In script"])
        expect(labels(all, "brightpad")).toEqual(["Create Vaporisateur · Bright Pad"])
        expect(labels(all, "padbr")).toEqual([])
    })
    it("only matches at the start of a word, never inside one", () => {
        const compressor = entry("Create Compressor", {names: ["Compressor"]})
        const preferences = entry("Go to Preferences", {names: ["Preferences"], verb: "goto"})
        expect(labels([compressor, preferences], "pre")).toEqual(["Go to Preferences"])
        expect(labels([compressor, preferences], "ress")).toEqual([])
        expect(labels(all, "ade")).toEqual([])
    })
    it("always puts disabled entries last, whatever their rank or group", () => {
        const chorus = entry("Create Chorus", {names: ["Chorus"], disabled: Option.wrap("Select an audio unit first")})
        const chord = entry("Create Chord", {names: ["Chord"]})
        const chorusPreset = entry("Create Reverb · Chorus Hall", {names: ["Chorus Hall"], group: 2})
        expect(labels([chorus, chord], "cho")).toEqual(["Create Chord", "Create Chorus"])
        expect(labels([chorus, chorusPreset], "chorus")).toEqual(["Create Reverb · Chorus Hall", "Create Chorus"])
        expect(SpotlightEntry.frequent([chorus, chord], "create", target => target === chorus ? 9 : 0)
            .map(({label}) => label)).toEqual(["Create Chord", "Create Chorus"])
        expect(SpotlightEntry.browse([chorus, chorusPreset], "").map(({label}) => label))
            .toEqual(["Create Reverb · Chorus Hall", "Create Chorus"])
    })
    it("lists every verb without one, only the typed verb with one", () => {
        const removeDelay = entry("Remove Delay", {names: ["Delay"], verb: "remove"})
        expect(labels([delay, removeDelay], "delay", Option.wrap("remove"))).toEqual(["Remove Delay"])
        expect(labels([delay, removeDelay], "delay", Option.wrap("create"))).toEqual(["Create Delay"])
        expect(labels([delay, removeDelay], "delay")).toEqual(["Create Delay", "Remove Delay"])
    })
    it("is case insensitive", () => {
        expect(labels(all, "VAPO")).toEqual(["Create Vaporisateur"])
    })
})

describe("SpotlightEntry.browse", () => {
    const presets = [
        entry("Create Vaporisateur · Dark Pad", {names: ["Dark Pad"], qualifiers: ["Vaporisateur"], group: 2}),
        entry("Create Vaporisateur · Bright Pad", {names: ["Bright Pad"], qualifiers: ["Vaporisateur"], group: 1}),
        entry("Create Vaporisateur · Bass", {names: ["Bass"], qualifiers: ["Vaporisateur"], group: 2})
    ]
    const browsed = (subject: string) => SpotlightEntry.browse(presets, subject).map(({label}) => label)

    it("lists every child for an empty subject, user before stock, then by label", () => {
        expect(browsed("")).toEqual(["Create Vaporisateur · Bright Pad", "Create Vaporisateur · Bass", "Create Vaporisateur · Dark Pad"])
    })
    it("filters the children by name", () => {
        expect(browsed("pad")).toEqual(["Create Vaporisateur · Bright Pad", "Create Vaporisateur · Dark Pad"])
        expect(browsed("ba")).toEqual(["Create Vaporisateur · Bass"])
    })
})

describe("SpotlightEntry.frequent", () => {
    const bundle = entry("Open Bundle...", {names: ["Open Bundle"], verb: "open"})
    const stems = entry("Import Stems...", {names: ["Import Stems"], verb: "open"})
    const project = entry("Open Project...", {names: ["Open Project"], verb: "open"})
    const mixer = entry("Go to Mixer", {names: ["Mixer"], verb: "goto"})
    const all = [bundle, stems, project, mixer]

    it("lists every entry of the verb, most used first, then by label", () => {
        const usage = (target: SpotlightEntry) => target === project ? 5 : target === stems ? 2 : 0
        expect(SpotlightEntry.frequent(all, "open", usage).map(({label}) => label))
            .toEqual(["Open Project...", "Import Stems...", "Open Bundle..."])
    })
    it("falls back to the label order without usage", () => {
        expect(SpotlightEntry.frequent(all, "open", () => 0).map(({label}) => label))
            .toEqual(["Import Stems...", "Open Bundle...", "Open Project..."])
    })
})
