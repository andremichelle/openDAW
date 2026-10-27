import {describe, expect, it} from "vitest"
import {ByteArrayOutput, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {StorageWalk} from "@opendaw/lib-fusion"
import {
    AudioClipBox, AudioFileBox, AudioUnitBox, SoundfontDeviceBox, SoundfontFileBox, TrackBox, ValueEventCollectionBox, WclapDeviceBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {PresetHeader, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {StorageScan} from "./StorageScan"

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
const bytes = (length: number): Uint8Array => new Uint8Array(length)

type Uses = { samples?: ReadonlyArray<string>, soundfonts?: ReadonlyArray<string>, wclaps?: ReadonlyArray<[string, string]> }

const graphOf = ({samples = [], soundfonts = [], wclaps = []}: Uses): BoxGraph => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox, primaryAudioUnitBox}} =
        ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    samples.forEach((uuid, index) => {
        const fileBox = AudioFileBox.create(boxGraph, UUID.parse(uuid), box => box.fileName.setValue(uuid))
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        AudioClipBox.create(boxGraph, UUID.generate(), box => {
            box.index.setValue(index)
            box.clips.refer(trackBox.clips)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
    })
    soundfonts.forEach((uuid, index) => {
        const fileBox = SoundfontFileBox.create(boxGraph, UUID.parse(uuid))
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(index + 1)
            box.type.setValue(AudioUnitType.Instrument)
        })
        SoundfontDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.file.refer(fileBox)
        })
    })
    wclaps.forEach(([url, clapId], index) => WclapDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(primaryAudioUnitBox.audioEffects)
        box.index.setValue(index)
        box.url.setValue(url)
        box.clapId.setValue(clapId)
    }))
    boxGraph.endTransaction()
    return boxGraph
}

const project = (uses: Uses): Uint8Array => new Uint8Array(ProjectSkeleton.encode(graphOf(uses)))

const preset = (samples: ReadonlyArray<string>): Uint8Array => {
    const graph = graphOf({samples})
    const output = ByteArrayOutput.create()
    output.writeInt(PresetHeader.MAGIC_HEADER_OPEN)
    output.writeInt(PresetHeader.FORMAT_VERSION)
    output.writeBytes(new Int8Array(graph.toArrayBuffer()))
    return new Uint8Array(output.toArrayBuffer())
}

const SampleShared = "00000000-0000-4000-8000-000000000001"
const SampleUnused = "00000000-0000-4000-8000-000000000002"
const SampleMissing = "00000000-0000-4000-8000-000000000003"
const SamplePreset = "00000000-0000-4000-8000-000000000004"
const Font = "00000000-0000-4000-8000-0000000000f1"
const ProjectA = "00000000-0000-4000-8000-0000000000a1"
const ProjectB = "00000000-0000-4000-8000-0000000000b1"
const Broken = "00000000-0000-4000-8000-0000000000c1"
const Template = "00000000-0000-4000-8000-0000000000d1"
const PresetId = "00000000-0000-4000-8000-0000000000e1"
const Bundle = "11111111-2222-4333-8444-555555555555"
const BundleUnused = "66666666-7777-4888-8999-aaaaaaaaaaaa"

const createStorage = (): Map<string, Uint8Array> => new Map<string, Uint8Array>([
    [`projects/v1/${ProjectA}/project.od`, project({samples: [SampleShared, SampleMissing], wclaps: [[`opfs:${Bundle}`, "com.example.verb"]]})],
    [`projects/v1/${ProjectA}/meta.json`, json({name: "Song A"})],
    [`projects/v1/${ProjectA}/image.bin`, bytes(30)],
    [`projects/v1/${ProjectB}/project.od`, project({samples: [SampleShared], soundfonts: [Font], wclaps: [["https://cloud/x.tar.gz", "com.example.cloud"]]})],
    [`projects/v1/${ProjectB}/meta.json`, json({name: "Song B"})],
    [`projects/v1/${Broken}/project.od`, bytes(12)],
    [`projects/v1/${Broken}/meta.json`, json({name: "Broken"})],
    ["projects/v1/trash.json", json([])],
    [`templates/v1/${Template}/project.od`, project({samples: [SampleUnused]})],
    [`templates/v1/${Template}/meta.json`, json({name: "Starter"})],
    [`samples/v2/${SampleShared}/audio.wav`, bytes(1000)],
    [`samples/v2/${SampleShared}/peaks.bin`, bytes(100)],
    [`samples/v2/${SampleShared}/meta.json`, json({name: "Kick", origin: "import"})],
    [`samples/v2/${SampleUnused}/audio.wav`, bytes(500)],
    [`samples/v2/${SampleUnused}/meta.json`, json({name: "Snare", origin: "openDAW"})],
    [`samples/v2/${SamplePreset}/audio.wav`, bytes(10)],
    [`samples/v2/${SamplePreset}/meta.json`, json({name: "Pad"})],
    [`soundfont/${Font}/soundfont.sf2`, bytes(2000)],
    [`soundfont/${Font}/meta.json`, json({name: "Piano"})],
    [`wclap/${Bundle}/bundle.tar.gz`, bytes(4000)],
    [`wclap/${Bundle}/meta.json`, json({storedAt: 1})],
    [`wclap/${BundleUnused}/bundle.tar.gz`, bytes(3000)],
    ["wclap/tombstones.json", json({})],
    [`presets/user/${PresetId}.odp`, preset([SamplePreset])],
    ["presets/user/index.json", json([{uuid: PresetId, name: "My Pad"}])],
    ["scripts/v1/s1/script.ts", bytes(40)],
    ["scripts/v1/s1/meta.json", json({name: "Arp Script"})],
    ["inference/models/stems/3/model.onnx", bytes(800)],
    ["inference/models/stems/3/meta.json", json({})],
    ["tone3000/42/pack.json", json({title: "Plexi"})],
    ["tone3000/42/models/7.nam", bytes(60)],
    [".backup/project.od", bytes(70)],
    ["samples/v1/old/audio.wav", bytes(90)]
])

const run = async (storage: Map<string, Uint8Array>) => {
    const walk: StorageWalk.Result = {
        files: Array.from(storage, ([path, data]) => ({path, size: data.byteLength})), failures: ["locked/file"]
    }
    const read: StorageScan.Reader = path => {
        const data = storage.get(path)
        return data === undefined ? Promise.reject(new Error(`not found ${path}`)) : Promise.resolve(data)
    }
    const progress: Array<number> = []
    const report = await StorageScan.scan(walk, read, value => progress.push(value))
    const asset = (kind: StorageScan.AssetKind, id: string) =>
        report.assets.find(entry => entry.kind === kind && entry.id === id)
    const item = (kind: StorageScan.ItemKind, id: string) =>
        report.items.find(entry => entry.kind === kind && entry.id === id)
    return {report, progress, asset, item, storage}
}

describe("StorageScan", () => {
    it("lists who uses each sample", async () => {
        const {asset} = await run(createStorage())
        expect(asset("sample", SampleShared)).toMatchObject({
            name: "Kick", size: 1000 + 100 + json({name: "Kick", origin: "import"}).byteLength,
            path: `samples/v2/${SampleShared}`,
            usedBy: [{kind: "project", id: ProjectA}, {kind: "project", id: ProjectB}]
        })
        expect(asset("sample", SampleShared)?.origin).toBe("import")
        expect(asset("sample", SampleUnused)?.usedBy).toEqual([{kind: "template", id: Template}])
        expect(asset("sample", SamplePreset)?.usedBy).toEqual([{kind: "preset", id: PresetId}])
    })

    it("lists soundfonts and local WebCLAP bundles, named by the clap id that uses them", async () => {
        const {asset} = await run(createStorage())
        expect(asset("soundfont", Font)).toMatchObject({name: "Piano", usedBy: [{kind: "project", id: ProjectB}]})
        expect(asset("wclap", Bundle)).toMatchObject({
            name: "com.example.verb", clapIds: ["com.example.verb"], usedBy: [{kind: "project", id: ProjectA}]
        })
        expect(asset("wclap", BundleUnused)).toMatchObject({name: BundleUnused, usedBy: []})
    })

    it("marks references that are not stored locally", async () => {
        const {item} = await run(createStorage())
        expect(item("project", ProjectA)).toMatchObject({
            name: "Song A",
            uses: [{kind: "sample", id: SampleShared}, {kind: "wclap", id: Bundle}],
            notStored: [{kind: "sample", id: SampleMissing}]
        })
    })

    it("ignores WebCLAP urls that are not stored in OPFS", async () => {
        const {item} = await run(createStorage())
        expect(item("project", ProjectB)?.uses).toEqual([{kind: "sample", id: SampleShared}, {kind: "soundfont", id: Font}])
        expect(item("project", ProjectB)?.notStored).toEqual([])
    })

    it("keeps going past a project that cannot be decoded", async () => {
        const {report, item} = await run(createStorage())
        expect(report.failures).toEqual(["locked/file", `projects/v1/${Broken}/project.od`])
        expect(item("project", Broken)).toMatchObject({name: "Broken", uses: [], notStored: []})
    })

    it("names every other kind from its own meta", async () => {
        const {item} = await run(createStorage())
        expect(item("template", Template)?.name).toBe("Starter")
        expect(item("preset", PresetId)?.name).toBe("My Pad")
        expect(item("script", "s1")?.name).toBe("Arp Script")
        expect(item("model", "stems/3")?.name).toBe("stems 3")
        expect(item("nam-pack", "42")?.name).toBe("Plexi")
    })

    it("puts unknown folders into other and bookkeeping files into neither", async () => {
        const {report, storage} = await run(createStorage())
        expect(report.other.map(({path}) => path).sort()).toEqual([".backup/project.od", "samples/v1/old/audio.wav"])
        expect(report.bookkeeping).toBe(["projects/v1/trash.json", "wclap/tombstones.json", "presets/user/index.json"]
            .reduce((sum, path) => sum + (storage.get(path)?.byteLength ?? 0), 0))
        const listed = [...report.assets, ...report.items].reduce((sum, {size}) => sum + size, 0)
            + StorageWalk.totalSize(report.other) + report.bookkeeping
        expect(listed).toBe(report.total)
    })

    it("reports progress up to one", async () => {
        const {progress} = await run(createStorage())
        expect(progress.at(-1)).toBe(1.0)
        expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true)
    })

    it("returns an empty report for an empty storage", async () => {
        const report = await StorageScan.scan({files: [], failures: []}, () => Promise.reject(new Error()), () => {})
        expect(report).toEqual({total: 0, bookkeeping: 0, assets: [], items: [], other: [], failures: []})
    })
})
