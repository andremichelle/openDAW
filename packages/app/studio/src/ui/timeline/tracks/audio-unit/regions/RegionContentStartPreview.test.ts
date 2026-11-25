import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {LoopableRegion, PPQN, ppqn} from "@opendaw/lib-dsp"
import {NoteRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {RegionModifyStrategy} from "@opendaw/studio-core"

// The content-start preview must show the loop cycles and notes exactly where approve() puts them.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const Bar = PPQN.Bar
const Notes: ReadonlyArray<ppqn> = [0, 960, 2880]

const loadModules = async () => {
    const core = await import("@opendaw/studio-core")
    const {Snapping} = await import("@/ui/timeline/Snapping.ts")
    const {RegionContentStartModifier} = await import("./RegionContentStartModifier.ts")
    return {...core, Snapping, RegionContentStartModifier}
}
type Modules = Awaited<ReturnType<typeof loadModules>>

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

type Setup = Readonly<{ position: ppqn, duration: ppqn, loopOffset: ppqn, loopDuration: ppqn }>

const buildProject = (modules: Modules, {position, duration, loopOffset, loopDuration}: Setup) => {
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.index.setValue(0)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    Notes.forEach(note => NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(note)
        box.duration.setValue(PPQN.SemiQuaver)
        box.events.refer(events.events)
    }))
    const regionBox = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(position)
        box.duration.setValue(duration)
        box.loopOffset.setValue(loopOffset)
        box.loopDuration.setValue(loopDuration)
        box.regions.refer(trackBox.regions)
        box.events.refer(events.owners)
    })
    boxGraph.endTransaction()
    const project = modules.Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof modules.Project.fromSkeleton>[0], skeleton)
    const track = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    track.listIndex = 0
    const region = project.boxAdapters.adapterFor(regionBox, NoteRegionBoxAdapter)
    region.onSelected()
    return {project, region}
}

type Picture = Readonly<{ position: ppqn, complete: ppqn, boundaries: ReadonlyArray<ppqn>, notes: ReadonlyArray<ppqn> }>

const picture = (region: NoteRegionBoxAdapter, strategy: RegionModifyStrategy): Picture => {
    const position = strategy.readPosition(region)
    const complete = strategy.readComplete(region)
    const shift = strategy.readContentShift?.(region) ?? 0
    const loops = Array.from(LoopableRegion.locateLoops({
        position, complete, loopOffset: strategy.readLoopOffset(region), loopDuration: strategy.readLoopDuration(region)
    }, position, complete))
    const events = region.optCollection.unwrap("collection").events.asArray()
    return {
        position, complete,
        boundaries: loops.filter(pass => pass.index > 0).map(pass => pass.resultStart),
        notes: loops.flatMap(pass => events.map(event => pass.rawStart + shift + event.position)
            .filter(global => global >= pass.resultStart && global < pass.resultEnd))
    }
}

const Cases: ReadonlyArray<Readonly<{ name: string, setup: Setup, target: ppqn }>> = [
    {name: "looping, extend left", setup: {position: Bar, duration: Bar * 3.5, loopOffset: 0, loopDuration: Bar}, target: Bar / 2},
    {name: "looping, trim right", setup: {position: Bar, duration: Bar * 3.5, loopOffset: 0, loopDuration: Bar}, target: Bar + 480},
    {name: "looping with offset, extend left", setup: {position: Bar, duration: Bar * 3, loopOffset: 960, loopDuration: Bar}, target: 0},
    {name: "not looping, extend left", setup: {position: Bar, duration: Bar, loopOffset: 0, loopDuration: Bar}, target: Bar / 2}
]

describe("content-start preview matches the approved result", () => {
    Cases.forEach(({name, setup, target}) => it(name, async () => {
        const modules = await loadModules()
        const {project, region} = buildProject(modules, setup)
        const range = new modules.TimelineRange({padding: 0})
        range.maxUnits = Bar * 16
        range.width = 65536
        range.showAll()
        const snapping = new modules.Snapping(range)
        snapping.index = 8
        const element = {getBoundingClientRect: () => ({left: 0})} as unknown as Element
        const modifier = modules.RegionContentStartModifier.create([region], {
            project, element, snapping, pointerPulse: region.position, reference: region
        }).unwrap("modifier")
        const {debug} = console
        console.debug = () => {}
        modifier.update({clientX: range.unitToX(target), clientY: 0, altKey: false, shiftKey: false, ctrlKey: false})
        expect(modifier.delta).toBe(target - setup.position)
        const preview = picture(region, modifier.selectedModifyStrategy())
        const firstBoundaryBefore = picture(region, modules.RegionModifyStrategy.Identity).boundaries[0]
        modifier.approve()
        console.debug = debug
        const approved = picture(region, modules.RegionModifyStrategy.Identity)
        expect(preview).toEqual(approved)
        if (isDefined(firstBoundaryBefore)) {expect(approved.boundaries[0]).toBe(firstBoundaryBefore)}
        project.terminate()
    }))
})
