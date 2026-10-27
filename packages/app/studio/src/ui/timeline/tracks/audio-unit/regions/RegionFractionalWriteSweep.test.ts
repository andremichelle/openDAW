import {afterAll, beforeAll, describe, expect, it} from "vitest"
import {int, isDefined, Option, Selection, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {PPQN, ppqn, TimeBase} from "@opendaw/lib-dsp"
import {Int32Field} from "@opendaw/lib-box"
import {AnyRegionBoxAdapter, AudioRegionBoxAdapter, ProjectSkeleton, RegionEditing, TrackBoxAdapter, TrackType}
    from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, NoteRegionBox, TrackBox, ValueEventCollectionBox, ValueRegionBox}
    from "@opendaw/studio-boxes"
import type {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"

// Sweep for live error 1191 and its family: every region gesture, run over tracks whose audio regions end on a
// fractional pulse, in all three overlap behaviours. A region's Int32 fields (position, and duration/loop fields
// on note and value regions) silently truncate a fractional write. The guard below records each such write with
// its call site instead, so one run lists every site that hands a region a fractional start.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

type Behaviour = "clip" | "push-existing" | "keep-existing"
type Layout = ReadonlyArray<Readonly<{ position: ppqn, length: ppqn, loop: ppqn, timeBase: TimeBase }>>

const F: ppqn = 418.3945617675781 // live loopDuration of 1191 (float32)
const Bpm = 120

// Track 0 carries the fractional regions, track 1 is a second audio track for cross-track moves.
const Layouts: ReadonlyArray<Layout> = [[
    {position: 960, length: F, loop: F, timeBase: TimeBase.Musical},
    {position: 1920, length: F, loop: F, timeBase: TimeBase.Musical},
    {position: 2400, length: 2400, loop: F, timeBase: TimeBase.Musical},
    {position: 6720, length: F * 3, loop: F, timeBase: TimeBase.Musical},
    {position: 9600, length: 0.4357, loop: 0.4357, timeBase: TimeBase.Seconds}
], [
    {position: 1440, length: F, loop: F, timeBase: TimeBase.Musical},
    {position: 4800, length: 960, loop: F, timeBase: TimeBase.Musical}
]]

type Site = { count: int, example: string, gestures: Set<string> }
const fractionalWrites = new Map<string, Site>()
const panics = new Map<string, { count: int, gestures: Set<string>, examples: Map<string, string> }>()
let currentGesture = ""

const isRegionBox = (box: unknown): boolean =>
    box instanceof AudioRegionBox || box instanceof NoteRegionBox || box instanceof ValueRegionBox

const callSite = (): string => {
    const frames = (new Error().stack ?? "").split("\n").slice(1).map(line => line.trim())
    const ours = frames.filter(frame => !frame.includes("/lib/box/") && !frame.includes("RegionFractionalWriteSweep")
        && !frame.includes("node_modules") && !frame.includes("/lib/std/"))
    return ours.slice(0, 3).map(frame => frame.replace(/^at /, "").replace(/\(?\/.*\/packages\//, "(")).join(" <- ")
}

const originalClamp = Int32Field.prototype.clamp
beforeAll(() => {
    Int32Field.prototype.clamp = function (this: Int32Field, value: int): int {
        if (!Number.isInteger(value) && isRegionBox(this.box)) {
            const site = callSite()
            const entry = fractionalWrites.get(site) ?? {count: 0, example: "", gestures: new Set<string>()}
            entry.count++
            entry.example = `${this.box.name}.${this.fieldName} <- ${value}`
            entry.gestures.add(currentGesture.split(" ")[0])
            fractionalWrites.set(site, entry)
        }
        return originalClamp.call(this, value)
    }
})
afterAll(() => {Int32Field.prototype.clamp = originalClamp})

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const loadModules = async () => {
    const core = await import("@opendaw/studio-core")
    const {Snapping} = await import("@/ui/timeline/Snapping.ts")
    const {RegionStartModifier} = await import("./RegionStartModifier.ts")
    const {RegionDurationModifier} = await import("./RegionDurationModifier.ts")
    const {RegionLoopDurationModifier} = await import("./RegionLoopDurationModifier.ts")
    const {RegionContentStartModifier} = await import("./RegionContentStartModifier.ts")
    const {RegionMoveInTrackModifier} = await import("./RegionMoveInTrackModifier.ts")
    const {RegionMoveModifier} = await import("./RegionMoveModifier.ts")
    return {
        ...core, Snapping, RegionStartModifier, RegionDurationModifier, RegionLoopDurationModifier,
        RegionContentStartModifier, RegionMoveInTrackModifier, RegionMoveModifier
    }
}
type Modules = Awaited<ReturnType<typeof loadModules>>

const buildProject = (modules: Modules) => {
    const {Project} = modules
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(60))
    const trackBoxes = Layouts.map((layout, index) => {
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.index.setValue(index)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        layout.forEach(({position, length, loop, timeBase}) => {
            const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
            AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                box.timeBase.setValue(timeBase)
                box.position.setValue(position)
                box.duration.setValue(length)
                box.loopDuration.setValue(loop)
                box.loopOffset.setValue(0)
                box.regions.refer(trackBox.regions)
                box.file.refer(fileBox)
                box.events.refer(events.owners)
            })
        })
        return trackBox
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
    project.timelineBox.bpm.setValue(Bpm)
    const tracks = trackBoxes.map(trackBox => project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter))
    tracks.forEach((track, index) => track.listIndex = index) // TracksManager does this in the app
    return {project, tracks}
}

const createSelection = (): Selection<AnyRegionBoxAdapter> => {
    const selected: Array<AnyRegionBoxAdapter> = []
    const selection = {
        select: (...regions: Array<AnyRegionBoxAdapter>) => regions.forEach(region => {
            if (selected.includes(region)) {return}
            selected.push(region)
            region.onSelected()
        }),
        deselect: (...regions: Array<AnyRegionBoxAdapter>) => regions.forEach(region => {
            const index = selected.indexOf(region)
            if (index === -1) {return}
            selected.splice(index, 1)
            region.onDeselected()
        }),
        deselectAll: () => selection.deselect(...selected.slice()),
        isSelected: (region: AnyRegionBoxAdapter) => selected.includes(region),
        isEmpty: () => selected.length === 0,
        nonEmpty: () => selected.length > 0,
        count: () => selected.length,
        selected: () => selected,
        distance: () => [],
        subscribe: () => Terminable.Empty,
        catchupAndSubscribe: () => Terminable.Empty
    }
    return selection
}

const subsets = <T>(items: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> =>
    [...items.map(item => [item]),
        ...items.flatMap((first, index) => items.slice(index + 1).map(second => [first, second])),
        items]

const Targets: ReadonlyArray<ppqn> = Array.from({length: 49}, (_ignored, index) => index * 240)
const Behaviours: ReadonlyArray<Behaviour> = ["clip", "push-existing", "keep-existing"]
const SnapIndices: ReadonlyArray<int> = [3, 8] // 1/4 and the finest grid

type Gesture = Readonly<{
    name: string
    run: (context: Readonly<{
        modules: Modules, project: ReturnType<typeof buildProject>["project"], tracks: ReadonlyArray<TrackBoxAdapter>,
        selection: Selection<AnyRegionBoxAdapter>, reference: AnyRegionBoxAdapter, target: ppqn, flag: boolean,
        snapIndex: int
    }>) => void
}>

const element = {getBoundingClientRect: () => ({left: 0})} as unknown as Element

const Gestures: ReadonlyArray<Gesture> = [
    {
        name: "start", run: ({modules, project, selection, reference, target, flag, snapIndex}) => {
            const {range, snapping} = createSnapping(modules, snapIndex)
            const modifier = modules.RegionStartModifier.create(selection.selected(), {
                project, element, snapping, pointerPulse: reference.position + 0.37, reference
            }).unwrap("start")
            modifier.update(dragEvent(range.unitToX(target + 0.37), flag, false))
            modifier.approve()
        }
    },
    {
        name: "duration", run: ({modules, project, selection, reference, target, flag, snapIndex}) => {
            const {range, snapping} = createSnapping(modules, snapIndex)
            const modifier = modules.RegionDurationModifier.create(selection.selected(), {
                project, element, snapping, pointerPulse: reference.complete - 0.37,
                bounds: [reference.position, reference.complete]
            }).unwrap("duration")
            modifier.update(dragEvent(range.unitToX(target - 0.37), flag, false))
            modifier.approve()
        }
    },
    {
        name: "loop-duration", run: ({modules, project, selection, reference, target, snapIndex}) => {
            const {range, snapping} = createSnapping(modules, snapIndex)
            const modifier = modules.RegionLoopDurationModifier.create(selection.selected(), {
                project, element, snapping, pointerPulse: reference.position + 0.37, reference
            }).unwrap("loop-duration")
            modifier.update(dragEvent(range.unitToX(target + 0.37), false, false))
            modifier.approve()
        }
    },
    {
        name: "content-start", run: ({modules, project, selection, reference, target, snapIndex}) => {
            const {range, snapping} = createSnapping(modules, snapIndex)
            const modifier = modules.RegionContentStartModifier.create(selection.selected(), {
                project, element, snapping, pointerPulse: reference.position + 0.37, reference
            }).unwrap("content-start")
            modifier.update(dragEvent(range.unitToX(target + 0.37), false, false))
            modifier.approve()
        }
    },
    {
        name: "move-in-track", run: ({modules, project, selection, reference, target, snapIndex}) => {
            const {range, snapping} = createSnapping(modules, snapIndex)
            const modifier = modules.RegionMoveInTrackModifier.create(selection.selected(), {
                project, element, snapping, pointerPulse: reference.position + 0.37, reference
            }).unwrap("move-in-track")
            modifier.update(dragEvent(range.unitToX(target + 0.37), false, false))
            modifier.approve()
        }
    },
    ...[0, 1].flatMap(deltaIndex => [false, true].map(mirrored => ({
        name: `move(index+${deltaIndex}${mirrored ? ",mirrored" : ""})`,
        run: ({modules, project, tracks, selection, reference, target, flag, snapIndex}) => {
            const {range, snapping} = createSnapping(modules, snapIndex)
            const manager = {
                service: {project},
                numTracks: () => tracks.length,
                globalToIndex: (clientY: number) => clientY,
                getByIndex: (index: int) => Option.wrap(tracks[index]).map(trackBoxAdapter => ({trackBoxAdapter}))
            } as unknown as TracksManager
            const pointerIndex = reference.trackBoxAdapter.unwrap("track").listIndex
            const modifier = modules.RegionMoveModifier.create(manager, selection, {
                element, snapping, pointerPulse: reference.position + 0.37, pointerIndex, reference
            }).unwrap("move")
            modifier.update({
                clientX: range.unitToX(target + 0.37), clientY: pointerIndex + deltaIndex,
                altKey: false, shiftKey: mirrored && flag, ctrlKey: flag
            })
            modifier.approve()
        }
    } satisfies Gesture))),
    {
        name: "cut", run: ({project, selection, target, flag}) => {
            project.editing.modify(() => selection.selected().slice()
                .forEach(region => RegionEditing.cut(region, target, !flag)))
        }
    },
    {
        name: "duplicate", run: ({project, reference}) => {
            project.editing.modify(() => project.api.duplicateRegion(reference))
        }
    }
]

const createSnapping = (modules: Modules, snapIndex: int) => {
    const range = new modules.TimelineRange({padding: 0})
    range.maxUnits = PPQN.fromSignature(64, 4)
    range.width = 65536
    range.showAll()
    const snapping = new modules.Snapping(range)
    snapping.index = snapIndex
    return {range, snapping}
}

const dragEvent = (clientX: number, ctrlKey: boolean, shiftKey: boolean) =>
    ({clientX, clientY: 0, altKey: false, shiftKey, ctrlKey})

const layoutOf = (tracks: ReadonlyArray<TrackBoxAdapter>): string => tracks
    .map(track => track.regions.collection.asArray()
        .map(region => `${UUID.toString(region.uuid)}:${region.position}:${region.duration}:${region.loopOffset}:${region.isSelected}`)
        .join(",")).join("|")

const selectionIntact = (selection: Selection<AnyRegionBoxAdapter>, count: int): boolean =>
    selection.count() === count && selection.selected().every(region => region.box.isAttached())

const record = (message: string) => {
    const family = message.replace(/-?\d+(\.\d+)?(e-?\d+)?/g, "#")
    const entry = panics.get(family) ?? {count: 0, gestures: new Set<string>(), examples: new Map<string, string>()}
    entry.count++
    const gesture = currentGesture.split(" ")[0]
    entry.gestures.add(gesture)
    if (!entry.examples.has(gesture)) {entry.examples.set(gesture, `${currentGesture} :: ${message}`)}
    panics.set(family, entry)
}

describe("region gestures never write a fractional Int32 value (#1191 sweep)", () => {
    it("sweeps every gesture over fractional-end regions", async () => {
        const modules = await loadModules()
        const {StudioPreferences, RegionClipResolver} = modules
        const previous = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        const {debug, log, warn} = console
        // validateTrack and ContentStartModifier dump layouts per run, vitest buffers them all
        console.debug = console.log = console.warn = () => {}
        let runs = 0
        let rebuilds = 0
        for (const behaviour of Behaviours) {
            StudioPreferences.settings.editing["overlapping-regions-behaviour"] = behaviour
            for (const gesture of Gestures) {
                const probe = buildProject(modules)
                const regionCount = probe.tracks[0].regions.collection.asArray().length
                probe.project.terminate()
                const selections = subsets(Array.from({length: regionCount}, (_ignored, index) => index))
                for (const selected of selections) {
                    for (const referenceIndex of selected) {
                        const fresh = () => {
                            const built = buildProject(modules)
                            const regions = built.tracks[0].regions.collection.asArray()
                            const selection = createSelection()
                            selection.select(...selected.map(index => regions[index]))
                            const originals = selection.selected().slice()
                            return {
                                ...built, selection, originals, reference: regions[referenceIndex],
                                layout: layoutOf(built.tracks)
                            }
                        }
                        let state = fresh()
                        for (const target of Targets) {
                            for (const flag of [false, true]) {
                                for (const snapIndex of SnapIndices) {
                                    const {project, tracks, selection, originals, reference, layout} = state
                                    currentGesture = `${gesture.name} ${behaviour} sel=${selected} ref=${referenceIndex} to=${target} flag=${flag} snap=${snapIndex}`
                                    const result = tryCatch(() => {
                                        gesture.run({modules, project, tracks, selection, reference, target, flag, snapIndex})
                                        tracks.forEach(track => RegionClipResolver.validateTrack(track))
                                    })
                                    if (result.status === "failure") {record(String(result.error))}
                                    runs++
                                    const restored = tryCatch(() => {
                                        while (project.editing.canUndo()) {project.editing.undo()}
                                        selection.deselectAll()
                                        selection.select(...originals)
                                        return layoutOf(tracks) === layout && selectionIntact(selection, selected.length)
                                    })
                                    if (restored.status === "success" && restored.value) {continue}
                                    rebuilds++
                                    project.terminate()
                                    state = fresh()
                                }
                            }
                        }
                        state.project.terminate()
                    }
                }
                process.stderr.write(`${behaviour} ${gesture.name}: ${runs} runs, ${rebuilds} rebuilds, `
                    + `${Math.round(process.memoryUsage().heapUsed / 1e6)} MB\n`)
            }
        }
        StudioPreferences.settings.editing["overlapping-regions-behaviour"] = previous
        Object.assign(console, {debug, log, warn})
        console.log(`runs: ${runs}`)
        console.log("FRACTIONAL WRITES", JSON.stringify([...fractionalWrites.entries()]
            .map(([site, {count, example, gestures}]) => ({site, count, example, gestures: [...gestures]})), null, 1))
        console.log("FAILURES", JSON.stringify([...panics.entries()]
            .map(([family, {count, gestures, examples}]) =>
                ({family, count, gestures: [...gestures], examples: [...examples.values()]})), null, 1))
        expect([...fractionalWrites.keys()]).toEqual([])
        expect([...panics.keys()]).toEqual([])
    }, 1_800_000)
})
