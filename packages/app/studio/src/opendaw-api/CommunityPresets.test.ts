import {describe, expect, it} from "vitest"
import {CommunityIndex, PresetDevices} from "./CommunityIndex"

const Devices: PresetDevices = {
    isInstrument: (key: string): key is never => ["Vaporisateur", "Apparat"].includes(key),
    isAudioEffect: (key: string): key is never => ["Delay"].includes(key),
    isMidiEffect: (key: string): key is never => ["Arpeggio"].includes(key)
}

const entry = (overrides: Record<string, unknown> = {}) => ({
    uuid: "640a9318-9e11-4b34-b791-317fc5a30dab",
    slug: "flanger",
    name: "Flanger",
    description: "A flanger.",
    author: {name: "openDAW", url: "https://opendaw.studio"},
    tags: [],
    license: "CC-BY-SA-4.0",
    credits: "openDAW, https://opendaw.studio",
    kind: "device",
    device: "Delay",
    folder: "",
    hasTimeline: false,
    url: "640a9318-9e11-4b34-b791-317fc5a30dab-0123456789ab.odp",
    size: 1234,
    created: 1,
    modified: 2,
    source: "https://github.com/andremichelle/opendaw-commons/tree/main/presets/Delay/flanger",
    ...overrides
})

describe("CommunityIndex.parsePresets", () => {
    it("reads the commons preset index", () => {
        const presets = CommunityIndex.parsePresets({version: 1, updatedAt: "now", presets: [entry()]})
        expect(presets.map(preset => preset.name)).toEqual(["Flanger"])
    })
    it("skips an entry it does not understand, never the whole index", () => {
        const presets = CommunityIndex.parsePresets({
            version: 1, presets: [entry({kind: "plugin"}), entry({url: "../escape"}), entry({uuid: "x"}), entry()]
        })
        expect(presets.length).toBe(1)
    })
    it("rejects an index of another version", () => {
        expect(() => CommunityIndex.parsePresets({version: 2, presets: []})).toThrow()
    })
})

describe("CommunityIndex.toPresetMeta", () => {
    const meta = (overrides: Record<string, unknown> = {}) =>
        CommunityIndex.toPresetMeta(CommunityIndex.parsePresets({version: 1, presets: [entry(overrides)]})[0], Devices)
    it("maps an effect preset with author, license and credits", () => {
        const preset = meta().unwrap()
        expect(preset.category).toBe("audio-effect")
        expect(preset.uuid).toBe("640a9318-9e11-4b34-b791-317fc5a30dab")
        expect(preset.author).toBe("openDAW")
        expect(preset.license).toBe("CC-BY-SA-4.0")
        expect(preset.credits).toBe("openDAW, https://opendaw.studio")
        expect(preset.folder).toBeUndefined()
        expect(preset.hasTimeline).toBe(false)
    })
    it("keeps a folder and drops empty credits", () => {
        const preset = meta({folder: "Modulation", credits: "", license: "CC0-1.0"}).unwrap()
        expect(preset.folder).toBe("Modulation")
        expect(preset.credits).toBeUndefined()
    })
    it("takes the category of a device preset from its device", () => {
        const instrument = meta({device: "Vaporisateur"}).unwrap()
        expect(instrument.category === "instrument" && instrument.device).toBe("Vaporisateur")
        const midi = meta({device: "Arpeggio"}).unwrap()
        expect(midi.category === "midi-effect" && midi.device).toBe("Arpeggio")
    })
    it("maps racks and chains", () => {
        const rack = meta({kind: "rack", device: "Apparat"}).unwrap()
        expect(rack.category === "audio-unit" && rack.instrument).toBe("Apparat")
        expect(meta({kind: "audio-effect-chain", device: ""}).unwrap().category).toBe("audio-effect-chain")
        expect(meta({kind: "midi-effect-chain", device: ""}).unwrap().category).toBe("midi-effect-chain")
    })
    it("carries the cloud files and their size as a download", () => {
        const sample = "0f0e0d0c-0b0a-4908-8706-050403020100"
        const preset = meta({samples: [sample], soundfonts: [], downloadSize: 30000000}).unwrap()
        expect(preset.download).toEqual({samples: [sample], soundfonts: [], size: 30000000})
        expect(meta().unwrap().download).toBeUndefined()
        expect(meta({samples: ["../escape"]}).isEmpty()).toBe(true)
    })
    it("hides a preset for a device this Studio does not know", () => {
        expect(meta({device: "FutureDevice"}).isEmpty()).toBe(true)
        expect(meta({kind: "rack", device: "Delay"}).isEmpty()).toBe(true)
        expect(meta({kind: "rack", device: "FutureSynth"}).isEmpty()).toBe(true)
    })
})
