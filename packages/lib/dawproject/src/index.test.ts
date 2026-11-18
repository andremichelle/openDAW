// @vitest-environment node
import {describe, expect, it} from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import JSZip from "jszip"
import {asDefined, asInstanceOf, isInstanceOf} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {
    ApplicationSchema,
    BoolParameterSchema,
    ChannelSchema,
    ClapPluginSchema,
    ClapPreset,
    ClipsSchema,
    ContentType,
    DeviceRole,
    EqualizerSchema,
    LanesSchema,
    MetaDataSchema,
    MixerRole,
    NotesSchema,
    PointsSchema,
    ProjectSchema,
    RealParameterSchema,
    TrackSchema,
    Unit,
    WarpsSchema
} from "./"
import {XsdValidator} from "../test/XsdValidator"

const testFiles = path.resolve(__dirname, "../../../../test-files")
const readZip = async (file: string): Promise<JSZip> => JSZip.loadAsync(fs.readFileSync(path.join(testFiles, file)))
const projectXmlOf = async (file: string): Promise<string> => asDefined((await readZip(file)).file("project.xml")).async("string")
// the files Bitwig Studio wrote, opendaw-legacy.dawproject is an invalid export of an earlier openDAW
const fixtures = fs.readdirSync(testFiles).filter(file => file.endsWith(".dawproject") && file !== "opendaw-legacy.dawproject")

describe("DAWproject schema", () => {
    it("writes MetaData that validates and reads back", () => {
        const metaData = Xml.element({title: "Title & <more>", artist: "André Michelle", website: "https://opendaw.studio"}, MetaDataSchema)
        const xml = Xml.write(metaData)
        expect(XsdValidator.validate(xml, "MetaData")).toBe("valid")
        const read = Xml.parse(xml, MetaDataSchema)
        expect(read.title).toBe("Title & <more>")
        expect(read.artist).toBe("André Michelle")
        expect(read.comment).toBeUndefined()
    })
    it.each(fixtures)("reads %s without unknown content and writes it back schema valid and unchanged", async file => {
        const xml = await projectXmlOf(file)
        expect(XsdValidator.validate(xml, "Project")).toBe("valid")
        const {value, issues} = Xml.read(xml, ProjectSchema)
        expect(issues).toEqual([])
        const written = Xml.write(value)
        expect(XsdValidator.validate(written, "Project")).toBe("valid")
        expect(Xml.write(Xml.parse(written, ProjectSchema))).toBe(written)
    })
    it("reads the Bitwig example", () => {
        const xml = fs.readFileSync(path.join(testFiles, "bitwig.example.xml"), "utf-8")
        const {value: project, issues} = Xml.read(xml, ProjectSchema)
        expect(issues).toEqual([])
        const firstTrack = asInstanceOf(project.structure[0], TrackSchema)
        expect(firstTrack.channel?.audioChannels).toBe(2)
        expect(asInstanceOf(project.structure[1], TrackSchema).channel?.id).toBe("id10")
        expect(firstTrack.contentType).toEqual([ContentType.NOTES])
    })
    it("reads automation lanes, units and bool points", async () => {
        const project = Xml.parse(await projectXmlOf("automation.dawproject"), ProjectSchema)
        const track = asInstanceOf(project.structure[0], TrackSchema)
        const channel = asInstanceOf(track.channel, ChannelSchema)
        expect(channel.role).toBe(MixerRole.REGULAR)
        expect(channel.mute).toBeInstanceOf(BoolParameterSchema)
        expect(channel.volume?.value).toBeCloseTo(0.056333)
        expect(channel.sends[0].enable?.value).toBe(false)
        const lane = asInstanceOf(project.arrangement?.lanes?.lanes[0], LanesSchema)
        expect(lane.track).toBe(track.id)
        const points = lane.lanes.filter(timeline => isInstanceOf(timeline, PointsSchema))
        expect(points.map(({target}) => target.parameter)).toEqual(["id5", "id4", "id6"])
        expect(points[1].points.map(point => point.time)).toEqual([0, 1.5, 4])
    })
    it("reads nested audio clips with warps", async () => {
        const project = Xml.parse(await projectXmlOf("audio-regions.dawproject"), ProjectSchema)
        const lane = asInstanceOf(project.arrangement?.lanes?.lanes[0], LanesSchema)
        const outer = asInstanceOf(lane.lanes[0], ClipsSchema).clips[0]
        expect(outer.loopEnd).toBeCloseTo(1.8333330154418945)
        const inner = asInstanceOf(outer.content, ClipsSchema).clips[0]
        const warps = asInstanceOf(inner.content, WarpsSchema)
        expect(warps.warps.map(warp => warp.contentTime)).toEqual([0, 1])
        expect(warps.content.timeUnit).toBeUndefined()
    })
    it("reads equalizer bands", async () => {
        const project = Xml.parse(await projectXmlOf("eq.dawproject"), ProjectSchema)
        const devices = project.structure
            .filter((lane): lane is TrackSchema => isInstanceOf(lane, TrackSchema))
            .flatMap(track => track.channel?.devices ?? [])
        const equalizer = asInstanceOf(devices.find(device => isInstanceOf(device, EqualizerSchema)), EqualizerSchema)
        expect(equalizer.deviceRole).toBe(DeviceRole.AUDIO_FX)
        expect(equalizer.bands).toHaveLength(6)
        expect(equalizer.bands[0].q?.value).toBeCloseTo(1.037528)
        expect(equalizer.enabled?.value).toBe(true)
    })
    it("reads notes", async () => {
        const project = Xml.parse(await projectXmlOf("note-regions.dawproject"), ProjectSchema)
        const lane = asInstanceOf(project.arrangement?.lanes?.lanes[0], LanesSchema)
        const notes = asInstanceOf(asInstanceOf(lane.lanes[0], ClipsSchema).clips[0].content, NotesSchema)
        expect(notes.notes).toHaveLength(8)
        expect(notes.notes[0]).toMatchObject({time: 1, duration: 0.25, channel: 0, key: 72})
    })
    it("reads and writes Bitwig numbers including inf", () => {
        const xml = `<Project version="1.0"><Application name="x" version="1"/><Transport><Tempo unit="bpm" value="120.000000" min="-inf" max="inf"/></Transport></Project>`
        const project = Xml.parse(xml, ProjectSchema)
        expect(project.transport?.tempo?.min).toBe(Number.NEGATIVE_INFINITY)
        expect(Xml.write(project, {declaration: false})).toContain(`<Tempo max="inf" min="-inf" unit="bpm" value="120"/>`)
    })
    it("reports an unknown device role and reads the rest", () => {
        const xml = `<Project version="1.0"><Application name="x" version="1"/><Structure><Track id="t"><Channel id="c"><Devices><Device deviceName="d" deviceRole="mystery"/></Devices></Channel></Track></Structure></Project>`
        const {value, issues} = Xml.read(xml, ProjectSchema)
        expect(issues).toEqual(["Project/Structure/Track/Channel/Devices/Device@deviceRole: 'mystery' is not one of instrument, noteFX, audioFX, analyzer"])
        expect(asInstanceOf(value.structure[0], TrackSchema).channel?.devices[0].deviceName).toBe("d")
    })
    it("writes a ClapPlugin with parameters that validates", () => {
        const device = Xml.element({
            id: "d", deviceName: "Surge XT", deviceRole: DeviceRole.INSTRUMENT, deviceID: "org.surge-synth-team.surge-xt",
            parameters: [Xml.element({id: "p", parameterID: 1243907205, value: 0.625, min: 0, max: 1, unit: Unit.NORMALIZED}, RealParameterSchema)],
            enabled: Xml.element({value: true}, BoolParameterSchema)
        }, ClapPluginSchema)
        const project = Xml.element({
            version: "1.0", application: Xml.element({name: "openDAW", version: "1"}, ApplicationSchema),
            structure: [Xml.element({id: "t", channel: Xml.element({id: "c", devices: [device]}, ChannelSchema)}, TrackSchema)]
        }, ProjectSchema)
        expect(XsdValidator.validate(Xml.write(project), "Project")).toBe("valid")
    })
})

describe("ClapPreset", () => {
    it("decodes the Bitwig .clap-preset layout and encodes it back", () => {
        const state = new Uint8Array([1, 2, 3, 0, 255])
        const encoded = ClapPreset.encode({pluginId: "org.surge-synth-team.surge-xt", state})
        const bytes = new Uint8Array(encoded)
        expect(Array.from(bytes.subarray(0, 8))).toEqual([0x63, 0x6C, 0x61, 0x70, 0, 0, 0, 29])
        const decoded = ClapPreset.decode(encoded).unwrap()
        expect(decoded.pluginId).toBe("org.surge-synth-team.surge-xt")
        expect(Array.from(decoded.state)).toEqual([1, 2, 3, 0, 255])
    })
    it("rejects anything else", () => {
        expect(ClapPreset.decode(new Uint8Array([1, 2, 3]).buffer).isEmpty()).toBe(true)
        expect(ClapPreset.decode(new Uint8Array([0x63, 0x6C, 0x61, 0x70, 0, 0, 0, 99]).buffer).isEmpty()).toBe(true)
    })
})