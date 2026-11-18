import {describe, expect, it} from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import {asDefined, asInstanceOf, Class, isInstanceOf, Option} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {ClapPreset, FileReferenceSchema} from "@opendaw/lib-dawproject"
import {PPQN} from "@opendaw/lib-dsp"
import {
    AudioRegionBox,
    AudioTimeStretchBox,
    AudioUnitBox,
    NoteClipBox,
    NoteRegionBox,
    RevampDeviceBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    VaporisateurDeviceBox,
    WarpMarkerBox,
    WclapInstrumentBox,
    WclapParameterBox
} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, InterpolationFieldAdapter, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {DawProject} from "./DawProject"
import {DawProjectImport} from "./DawProjectImporter"
import {DawProjectExporter} from "./DawProjectExporter"
import {Xml} from "@opendaw/lib-xml"
import {silentSamples, testFiles, validate} from "./DawProject.test-helper"

const importFile = async (file: string, options: DawProjectImport.Options = {}) => {
    const decoded = await DawProject.decode(fs.readFileSync(path.join(testFiles, file)))
    const imported = await DawProjectImport.read(decoded.project, decoded.resources, options)
    return {...imported, project: decoded.project, resources: decoded.resources, readIssues: decoded.issues}
}

const boxesOf = <T extends Box>(skeleton: ProjectSkeleton, clazz: Class<T>): ReadonlyArray<T> =>
    skeleton.boxGraph.boxes().filter((box): box is T => isInstanceOf(box, clazz))

const unitNamed = (skeleton: ProjectSkeleton, name: string): AudioUnitBox => asDefined(boxesOf(skeleton, AudioUnitBox)
    .find(unit => unit.input.pointerHub.incoming().some(({box}) => Reflect.get(box, "label")?.getValue() === name)), name)

const tracksOf = (unit: AudioUnitBox): ReadonlyArray<TrackBox> => unit.tracks.pointerHub.incoming()
    .map(({box}) => asInstanceOf(box, TrackBox)).sort((left, right) => left.index.getValue() - right.index.getValue())

const eventsOf = (region: ValueRegionBox) => asInstanceOf(region.events.targetVertex.unwrap().box, ValueEventCollectionBox)
    .events.pointerHub.incoming().map(({box}) => asInstanceOf(box, ValueEventBox))
    .sort((left, right) => left.position.getValue() - right.position.getValue())
    .map(event => ({
        position: event.position.getValue(), value: event.value.getValue(),
        hold: InterpolationFieldAdapter.read(event.interpolation).type === "none"
    }))

const reexport = (skeleton: ProjectSkeleton): string => Xml.write(DawProjectExporter.write(skeleton, silentSamples(), {
    write: (path: string) => Xml.element({path, external: false}, FileReferenceSchema)
}))

describe("importing Bitwig Studio projects", () => {
    it.each(["audio-regions.dawproject", "automation.dawproject", "eq.dawproject", "note-regions.dawproject",
        "virtualcx.dawproject", "bitwig-clap.dawproject"])("%s imports and exports again", async file => {
        const {skeleton, readIssues} = await importFile(file)
        expect(readIssues).toEqual([])
        expect(skeleton.boxGraph.boxes().length).toBeGreaterThan(0)
        expect(validate(reexport(skeleton), "Project")).toBe("valid")
    })

    it("reads the loop windows of note clips", async () => {
        const {skeleton} = await importFile("note-regions.dawproject")
        const regions = boxesOf(skeleton, NoteRegionBox).map(region => ({
            position: region.position.getValue() / PPQN.Quarter, duration: region.duration.getValue() / PPQN.Quarter,
            loopOffset: region.loopOffset.getValue() / PPQN.Quarter, loopDuration: region.loopDuration.getValue() / PPQN.Quarter
        })).sort((left, right) => left.position - right.position || left.loopOffset - right.loopOffset)
        expect(regions).toEqual([
            {position: 0, duration: 4, loopOffset: 0, loopDuration: 2},
            {position: 1, duration: 3, loopOffset: 0.5, loopDuration: 1},
            {position: 1, duration: 3, loopOffset: 1, loopDuration: 2}
        ])
    })

    it("reads mixer automation in openDAW's own units", async () => {
        const {skeleton, issues} = await importFile("automation.dawproject")
        expect(issues).toEqual([])
        const unit = unitNamed(skeleton, "Inst 1")
        const valueTracks = tracksOf(unit).filter(track => track.type.getValue() === TrackType.Value)
        const byTarget = (field: { address: { equals(other: unknown): boolean } }) => asDefined(valueTracks
            .find(track => track.target.targetAddress.mapOr(address => field.address.equals(address), false)))
        const regionOf = (track: TrackBox) => asInstanceOf(track.regions.pointerHub.incoming()[0].box, ValueRegionBox)
        const pan = eventsOf(regionOf(byTarget(unit.panning)))
        expect(pan.map(({position, value}) => [position / PPQN.Quarter, value])).toEqual([[0, 0.5], [2, 0.0], [4, 1.0]])
        const volume = eventsOf(regionOf(byTarget(unit.volume)))
        expect(volume[0].value).toBeCloseTo(AudioUnitBoxAdapter.VolumeMapper.x(0.0), 5)
        expect(volume[1].value).toBeCloseTo(AudioUnitBoxAdapter.VolumeMapper.x(-9.0), 4)
        const mute = eventsOf(regionOf(byTarget(unit.mute)))
        expect(mute).toEqual([{position: 0, value: 0, hold: true}, {position: 2 * PPQN.Quarter, value: 1, hold: true}])
    })

    it("reads warped audio in a nested clip", async () => {
        const {skeleton, audioIds} = await importFile("audio-regions.dawproject")
        const [region] = boxesOf(skeleton, AudioRegionBox)
        expect(region.timeBase.getValue()).toBe("musical")
        expect(region.duration.getValue()).toBe(8 * PPQN.Quarter)
        expect(region.loopDuration.getValue()).toBeCloseTo(1.8333330154418945 * PPQN.Quarter, 3)
        const playMode = asInstanceOf(region.playMode.targetVertex.unwrap().box, AudioTimeStretchBox)
        const markers = playMode.warpMarkers.pointerHub.incoming().map(({box}) => asInstanceOf(box, WarpMarkerBox))
            .map(marker => [marker.position.getValue(), marker.seconds.getValue()]).sort((left, right) => left[0] - right[0])
        expect(markers).toEqual([[0, 0], [Math.round(1.8333330154418945 * PPQN.Quarter), 1]])
        expect(audioIds).toHaveLength(1)
    })

    it("turns the Bitwig EQ into Revamp", async () => {
        const {skeleton} = await importFile("eq.dawproject")
        const [revamp] = boxesOf(skeleton, RevampDeviceBox)
        expect(revamp.lowBell.gain.getValue()).toBeCloseTo(-9.0)
        expect(revamp.midBell.gain.getValue()).toBeCloseTo(12.0)
        expect(revamp.highShelf.gain.getValue()).toBeCloseTo(6.0)
        expect(revamp.highPass.enabled.getValue()).toBe(true)
    })

    it("replaces a CLAP plugin with an instrument when no WebCLAP is known (#563)", async () => {
        const {skeleton, issues} = await importFile("bitwig-clap.dawproject")
        expect(boxesOf(skeleton, WclapInstrumentBox)).toHaveLength(0)
        expect(boxesOf(skeleton, VaporisateurDeviceBox)).toHaveLength(3)
        expect(issues).toContain("'Surge XT' on 'Surge XT \"Kick - Classic\"' is not available in openDAW and was replaced.")
    })

    it("loads a CLAP plugin as the WebCLAP with the same id, state and automation (#563)", async () => {
        const requested: Array<string> = []
        const {skeleton, issues, resources} = await importFile("bitwig-clap.dawproject", {
            resolveClap: async pluginId => {
                requested.push(pluginId)
                return Option.wrap(`local:${pluginId}`)
            }
        })
        expect(requested).toEqual(["org.surge-synth-team.surge-xt", "org.surge-synth-team.surge-xt", "org.baconpaul.six-sines"])
        const instruments = boxesOf(skeleton, WclapInstrumentBox)
        expect(instruments.map(box => box.clapId.getValue()).sort()).toEqual([...requested].sort())
        expect(instruments.every(box => box.url.getValue() === `local:${box.clapId.getValue()}`)).toBe(true)
        const states = ["b244b980-c711-42e0-8e56-820408620ce0", "64f99a72-eb01-4fda-a2bc-ee05db9549fe", "f0411141-79f4-49ae-9445-a84bfea98fb6"]
            .map(uuid => ClapPreset.decode(resources.fromPath(`plugins/${uuid}.clap-preset`).buffer).unwrap())
            .map(({state}) => Array.from(state).join(",")).sort()
        expect(instruments.map(box => Array.from(new Uint8Array(box.pluginState.getValue().buffer)).join(",")).sort()).toEqual(states)
        const [drive] = boxesOf(skeleton, WclapParameterBox)
        expect(drive.clapId.getValue()).toBe(1243907205)
        expect(drive.label.getValue()).toBe("A Waveshaper Drive")
        const automation = boxesOf(skeleton, TrackBox).find(track => track.type.getValue() === TrackType.Value)
        expect(automation?.target.targetAddress.unwrap().equals(drive.value.address)).toBe(true)
        expect(boxesOf(skeleton, NoteClipBox)).toHaveLength(3)
        expect(issues).toEqual([])
    })
})

describe("importing earlier openDAW exports", () => {
    it("restores their devices from the old state files", async () => {
        const {skeleton} = await importFile("opendaw-legacy.dawproject")
        const instruments = boxesOf(skeleton, WclapInstrumentBox)
        expect(instruments.map(box => box.clapId.getValue()).sort())
            .toEqual(["org.baconpaul.six-sines", "org.surge-synth-team.surge-xt", "org.surge-synth-team.surge-xt"])
        expect(instruments.every(box => box.pluginState.getValue().byteLength > 0 || box.state.getValue().length > 0)).toBe(true)
    })
})
