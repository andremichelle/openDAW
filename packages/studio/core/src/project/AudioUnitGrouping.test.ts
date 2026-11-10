import {describe, expect, it, vi} from "vitest"
import {asDefined, asInstanceOf, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBusFactory, AudioUnitGroups, AudioUnitBoxAdapter, InstrumentFactories, ProjectSkeleton, DeviceHost, TransferAudioUnits} from "@opendaw/studio-adapters"
import {AudioUnitBox, AuxSendBox, TrackBox} from "@opendaw/studio-boxes"
import {AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"
import {AudioUnitsClipboard} from "../ui/clipboard/types/AudioUnitsClipboardHandler"
import {EffectFactories} from "../EffectFactories"
import type {ProjectEnv} from "./ProjectEnv"
import type {Project} from "./Project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const setup = async () => {
    const project = await createProject()
    const units = project.editing.modify(() => [0, 1, 2, 3].map(() =>
        project.api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox)).unwrap()
    return {project, units}
}

const expectOrder = (actual: ReadonlyArray<AudioUnitBox>, expected: ReadonlyArray<AudioUnitBox>): void => {
    expect(actual.map(unit => UUID.toString(unit.address.uuid))).toEqual(expected.map(unit => UUID.toString(unit.address.uuid)))
}

const select = (project: Project, units: ReadonlyArray<AudioUnitBox>): void => {
    project.audioUnitSelection.deselectAll()
    project.audioUnitSelection.select(...units)
}

const expectSelected = (project: Project, expected: ReadonlyArray<AudioUnitBox>): void => {
    const toKeys = (units: ReadonlyArray<AudioUnitBox>) => units.map(unit => UUID.toString(unit.address.uuid)).toSorted()
    expect(toKeys(project.audioUnitSelection.selected())).toEqual(toKeys(expected))
}

describe("track folders", () => {
    it("resolves a newly created unit's rerouted output through undo, redo and reload", async () => {
        const {project, units: [first]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([first]).unwrap()).unwrap()
        const bus = AudioUnitGroups.bus(group).unwrap()
        const added = project.editing.modify(() => {
            const unit = project.api.createAnyInstrument(InstrumentFactories.Neon).audioUnitBox
            unit.output.refer(bus.input)
            return unit
        }).unwrap()
        const uuid = added.address.uuid
        const check = (unit: AudioUnitBox) => {
            expect(unit.output.targetVertex.unwrap().address.equals(unit.output.targetAddress.unwrap())).true
            expect(AudioUnitGroups.parent(unit).unwrap().address.equals(group.address)).true
        }
        check(added)
        expect(project.editing.undo()).true
        expect(project.boxGraph.findBox(uuid).isEmpty()).true
        expect(project.editing.redo()).true
        check(project.boxGraph.findBox(uuid).unwrap() as AudioUnitBox)
        const restored = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        check(restored.boxGraph.findBox(uuid).unwrap() as AudioUnitBox)
        project.terminate()
    })
    it("extracts a nested group with its tracks, clips and processing into a new project", async () => {
        const {project, units: [first, second]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap()
        project.editing.modify(() => {
            project.grouping.create([second])
            project.api.insertEffect(group.audioEffects, EffectFactories.AudioNamed.StereoTool)
            project.api.createNoteClip(asInstanceOf(first.tracks.pointerHub.incoming()[0].box, TrackBox), 0)
        })
        const target = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        target.boxGraph.beginTransaction()
        const copies = TransferAudioUnits.transfer([group], target, {includeGroupDescendants: true, layoutOrder: true})
        target.boxGraph.endTransaction()
        expect(copies).toHaveLength(4)
        expect(AudioUnitGroups.subtree(target.mandatoryBoxes.rootBox, copies[0])).toHaveLength(4)
        expect(copies[0].audioEffects.pointerHub.size()).toBe(1)
        expect(copies.flatMap(unit => unit.tracks.pointerHub.incoming())
            .reduce((count, pointer) => count + asInstanceOf(pointer.box, TrackBox).clips.pointerHub.size(), 0)).toBe(1)
        expect(AudioUnitGroups.bus(copies[0]).unwrap().output.targetVertex.unwrap().box).toBe(copies[0])
        expect(copies.slice(1).every(unit => AudioUnitGroups.parent(unit).nonEmpty())).true
        project.terminate()
    })
    it("inserts browser instruments after the selected track and advances selection for repeated additions", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        select(project, [second])
        const added = project.editing.modify(() => project.api.createInstrumentAfterSelection(InstrumentFactories.Neon)).unwrap().audioUnitBox
        const next = project.editing.modify(() => project.api.createInstrumentAfterSelection(InstrumentFactories.Cubed)).unwrap().audioUnitBox
        expectOrder(AudioUnitGroups.children(project.rootBox), [first, second, added, next, third, fourth, project.primaryAudioUnitBox])
        expectSelected(project, [next])
        project.terminate()
    })
    it("inserts a browser instrument inside the selected track's nested group with the matching audio route", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        const outer = asDefined(project.editing.modify(() => project.grouping.create([first, second, third]).unwrap()).unwrap())
        const inner = asDefined(project.editing.modify(() => project.grouping.create([second, third]).unwrap()).unwrap())
        select(project, [second])
        const before = AudioUnitGroups.ordered(project.rootBox)
        const added = project.editing.modify(() => project.api.createInstrumentAfterSelection(InstrumentFactories.Neon)).unwrap().audioUnitBox
        expectOrder(AudioUnitGroups.children(project.rootBox, inner), [second, added, third])
        expectOrder(AudioUnitGroups.children(project.rootBox, outer), [first, inner])
        expectOrder(AudioUnitGroups.children(project.rootBox), [outer, fourth, project.primaryAudioUnitBox])
        expect(added.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(inner).unwrapOrUndefined())
        const after = AudioUnitGroups.ordered(project.rootBox)
        const loaded = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        expectOrder(AudioUnitGroups.ordered(loaded.mandatoryBoxes.rootBox), after)
        expect(project.editing.undo()).toBe(true)
        expectOrder(AudioUnitGroups.ordered(project.rootBox), before)
        expect(project.editing.redo()).toBe(true)
        expectOrder(AudioUnitGroups.ordered(project.rootBox), after)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("inserts after the last selected root in visible order and after a selected folder's whole subtree", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        const group = asDefined(project.editing.modify(() => project.grouping.create([second, third]).unwrap()).unwrap())
        select(project, [third, group])
        const added = project.editing.modify(() => project.api.createInstrumentAfterSelection(InstrumentFactories.Neon)).unwrap().audioUnitBox
        expectOrder(AudioUnitGroups.children(project.rootBox), [first, group, added, fourth, project.primaryAudioUnitBox])
        select(project, [fourth, first])
        const last = project.editing.modify(() => project.api.createInstrumentAfterSelection(InstrumentFactories.Neon)).unwrap().audioUnitBox
        expectOrder(AudioUnitGroups.children(project.rootBox), [first, group, added, fourth, last, project.primaryAudioUnitBox])
        project.terminate()
    })
    it("ignores the edited unit when nothing is selected", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        project.userEditingManager.audioUnit.edit(first.editing)
        const added = project.editing.modify(() => project.api.createInstrumentAfterSelection(InstrumentFactories.Neon)).unwrap().audioUnitBox
        expectOrder(AudioUnitGroups.children(project.rootBox), [first, second, third, fourth, added, project.primaryAudioUnitBox])
        expectSelected(project, [added])
        select(project, [second])
        project.editing.modify(() => second.delete())
        expectSelected(project, [])
        const last = project.editing.modify(() => project.api.createInstrumentAfterSelection(InstrumentFactories.Neon)).unwrap().audioUnitBox
        expectOrder(AudioUnitGroups.children(project.rootBox), [first, third, fourth, added, last, project.primaryAudioUnitBox])
        project.terminate()
    })
    it("keeps a single selected track and an existing folder at their original sibling slots", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        const inner = asDefined(project.editing.modify(() => project.grouping.create([third]).unwrap()).unwrap())
        expectOrder(AudioUnitGroups.children(project.rootBox), [first, second, inner, fourth, project.primaryAudioUnitBox])
        expectOrder(AudioUnitGroups.children(project.rootBox, inner), [third])
        const outer = asDefined(project.editing.modify(() => project.grouping.create([fourth, inner]).unwrap()).unwrap())
        expectOrder(AudioUnitGroups.children(project.rootBox), [first, second, outer, project.primaryAudioUnitBox])
        expectOrder(AudioUnitGroups.children(project.rootBox, outer), [inner, fourth])
        expectOrder(AudioUnitGroups.children(project.rootBox, inner), [third])
        project.terminate()
    })
    it("groups FX buses in place and keeps the first selected FX first inside the group", async () => {
        const {project, units} = await setup()
        const buses = project.editing.modify(() => ["First FX", "Second FX"].map(label => {
            const bus = AudioBusFactory.create(project.skeleton, label, IconSymbol.Effects, AudioUnitType.Aux, Colors.green)
            return asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox)
        })).unwrap()
        const group = asDefined(project.editing.modify(() => project.grouping.create(buses.toReversed()).unwrap()).unwrap())
        expectOrder(AudioUnitGroups.children(project.rootBox), [...units, group, project.primaryAudioUnitBox])
        expectOrder(AudioUnitGroups.children(project.rootBox, group), buses)
        project.terminate()
    })
    it("shares immutable nested channel layout snapshots across collapse and undo", async () => {
        const {project, units: [first, second, third, outside]} = await setup()
        const outer = asDefined(project.editing.modify(() => project.grouping.create([first, second, third]).unwrap()).unwrap())
        const inner = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        const expanded = project.audioUnitLayout.snapshot
        expectOrder(expanded.visibleRows.map(row => row.unit), [outer, inner, first, second, third, outside, project.primaryAudioUnitBox])
        expect(expanded.visibleRows.map(row => row.indent)).toEqual([0, 5, 10, 10, 5, 0, 0])
        expect(expanded.boundaries.map(span => [span.start, span.end, span.depth])).toEqual([[0, 5, 0], [1, 4, 1]])
        project.editing.modify(() => inner.groupCollapsed.setValue(true))
        const folded = project.audioUnitLayout.snapshot
        expectOrder(folded.visibleRows.map(row => row.unit), [outer, inner, third, outside, project.primaryAudioUnitBox])
        expect(folded.row(first).unwrap().visibleIndex).toBe(-1)
        expect(folded.boundaries.map(span => [span.start, span.end])).toEqual([[0, 3], [1, 2]])
        expect(expanded.row(inner).unwrap().collapsed).toBe(false)
        expect(project.editing.undo()).toBe(true)
        expectOrder(project.audioUnitLayout.snapshot.visibleRows.map(row => row.unit), expanded.visibleRows.map(row => row.unit))
        project.terminate()
    })
    it("publishes one shared layout per transaction and ignores mixer parameter edits", async () => {
        const {project, units: [first, second, third]} = await setup()
        const group = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        const notify = vi.fn()
        const subscription = project.audioUnitLayout.value.subscribe(notify)
        project.editing.modify(() => {
            group.groupCollapsed.setValue(true)
            third.index.setValue(32)
            first.index.setValue(15)
            second.index.setValue(16)
        })
        expect(notify).toHaveBeenCalledTimes(1)
        project.editing.modify(() => {first.volume.setValue(-6); first.mute.setValue(true)})
        expect(notify).toHaveBeenCalledTimes(1)
        project.editing.modify(() => project.grouping.duplicate([group]))
        expect(notify).toHaveBeenCalledTimes(2)
        subscription.terminate()
        project.terminate()
    })

    it("rejects source and descendant drops while allowing exact track-order positions", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        const group = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        const nested = asDefined(project.editing.modify(() => project.grouping.create([first]).unwrap()).unwrap())
        const bus = project.editing.modify(() => AudioBusFactory.create(project.skeleton,
            "FX", IconSymbol.Effects, AudioUnitType.Aux, Colors.green)).unwrap()
        const fx = asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox)
        expect(project.grouping.canDrop([group], undefined, group)).toBe(false)
        expect(project.grouping.canDrop([group], nested, first)).toBe(false)
        expect(project.grouping.canDrop([group, first], group, second)).toBe(false)
        expect(project.grouping.canDrop([third], undefined, group)).toBe(true)
        expect(project.grouping.canDrop([third], undefined, project.primaryAudioUnitBox)).toBe(true)
        expect(project.grouping.canDrop([third], undefined, fourth)).toBe(false)
        expect(project.grouping.canDrop([third], undefined, fx)).toBe(true)
        expect(project.grouping.canDrop([fourth], group, first)).toBe(false)
        expect(project.grouping.canDrop([fourth], group, second)).toBe(true)
        expect(project.editing.modify(() => project.grouping.move([group], undefined, group)).unwrap()).toBe(false)
        project.terminate()
    })

    it("keeps selection and the edited unit independent", async () => {
        const {project, units: [first, second, third]} = await setup()
        const edit = (unit: AudioUnitBox) => project.userEditingManager.audioUnit.edit(unit.editing)
        select(project, [first, second])
        edit(third)
        expectSelected(project, [first, second])
        edit(project.primaryAudioUnitBox)
        expectSelected(project, [first, second])
        project.userEditingManager.audioUnit.clear()
        expectSelected(project, [first, second])
        select(project, [])
        edit(first)
        expectSelected(project, [])
        expect(project.userEditingManager.audioUnit.isEditing(first.editing)).toBe(true)
        project.terminate()
    })
    it("never lists the Output unit as selected", async () => {
        const {project, units: [first]} = await setup()
        project.audioUnitSelection.select(project.primaryAudioUnitBox, first)
        expectSelected(project, [first])
        expect(project.audioUnitSelection.isSelected(project.primaryAudioUnitBox)).toBe(false)
        project.terminate()
    })
    it("moves out only the selected members of the chosen folder", async () => {
        const {project, units: [first, second, other, outside]} = await setup()
        const left = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        const right = asDefined(project.editing.modify(() => project.grouping.create([other]).unwrap()).unwrap())
        project.editing.modify(() => project.grouping.moveOutOfGroup(first, [first, other]))
        expect(AudioUnitGroups.parent(first).unwrapOrUndefined()).toBeUndefined()
        expect(AudioUnitGroups.parent(other).unwrapOrUndefined()).toBe(right)
        expectOrder(AudioUnitGroups.children(project.rootBox), [left, first, right, outside, project.primaryAudioUnitBox])
        expectOrder(AudioUnitGroups.children(project.rootBox, left), [second])
        project.terminate()
    })
    it("pastes at the first matching channel section when no channel is being edited", async () => {
        const {project, units: [first, second, outside]} = await setup()
        project.editing.modify(() => project.grouping.create([first, second]).unwrap())
        const entry = AudioUnitsClipboard.copyEntry(project.boxAdapters.adapterFor(outside, AudioUnitBoxAdapter)).unwrap()
        const before = AudioUnitGroups.ordered(project.rootBox)
        const handler = AudioUnitsClipboard.createHandler({
            getEnabled: () => true, editing: project.editing, boxGraph: project.boxGraph,
            rootBoxAdapter: project.rootBoxAdapter, audioUnitEditing: project.userEditingManager.audioUnit,
            getEditedAudioUnit: () => Option.None
        })
        handler.paste(entry)
        const after = AudioUnitGroups.ordered(project.rootBox)
        const copy = asDefined(after.find(unit => !before.includes(unit)))
        expect(after.filter(unit => unit !== copy)).toEqual(before)
        expect(after[0]).toBe(copy)
        expect(after.at(-1)).toBe(project.primaryAudioUnitBox)
        project.terminate()
    })
    it("spans visible nested subtrees without gaps and retains folded child state", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        const outer = asDefined(project.editing.modify(() => project.grouping.create([first, second, third]).unwrap()).unwrap())
        const inner = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        const visible = () => AudioUnitGroups.ordered(project.rootBox).filter(unit => !AudioUnitGroups.hidden(unit))
        expect(visible()).toEqual([outer, inner, first, second, third, fourth, project.primaryAudioUnitBox])
        expect(project.audioUnitLayout.snapshot.boundaries.map(({indent, ...span}) => span)).toEqual([
            {unit: outer, start: 0, end: 5, depth: 0}, {unit: inner, start: 1, end: 4, depth: 1}
        ])
        project.editing.modify(() => inner.groupCollapsed.setValue(true))
        expect(project.audioUnitLayout.snapshot.boundaries.map(({indent, ...span}) => span)).toEqual([
            {unit: outer, start: 0, end: 3, depth: 0}, {unit: inner, start: 1, end: 2, depth: 1}
        ])
        project.editing.modify(() => outer.groupCollapsed.setValue(true))
        expect(project.audioUnitLayout.snapshot.boundaries.map(({indent, ...span}) => span)).toEqual([{unit: outer, start: 0, end: 1, depth: 0}])
        project.editing.modify(() => outer.groupCollapsed.setValue(false))
        expect(inner.groupCollapsed.getValue()).toBe(true)
        project.terminate()
    })
    it("creates FX buses after instruments and preserves explicit moves without rerouting sends", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        const folder = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        const bus = project.editing.modify(() => AudioBusFactory.create(project.skeleton,
            "FX", IconSymbol.Effects, AudioUnitType.Aux, Colors.green)).unwrap()
        const fx = asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox)
        expectOrder(AudioUnitGroups.children(project.rootBox), [folder, third, fourth, fx, project.primaryAudioUnitBox])
        const send = project.editing.modify(() => AuxSendBox.create(project.boxGraph, UUID.generate(), box => {
            box.audioUnit.refer(third.auxSends)
            box.targetBus.refer(bus.input)
            box.index.setValue(0)
        })).unwrap()
        project.editing.modify(() => project.grouping.move([fx], undefined, third))
        expectOrder(AudioUnitGroups.children(project.rootBox), [folder, fx, third, fourth, project.primaryAudioUnitBox])
        expect(fx.output.targetVertex.unwrap().box).toBe(project.primaryAudioBusBox)
        expect(send.targetBus.targetVertex.unwrap().box).toBe(bus)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("keeps explicit mixed channel order when grouping, moving and duplicating", async () => {
        const {project, units: [first, second, third]} = await setup()
        const bus = project.editing.modify(() => AudioBusFactory.create(project.skeleton,
            "FX", IconSymbol.Effects, AudioUnitType.Aux, Colors.green)).unwrap()
        const fx = asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox)
        project.editing.modify(() => project.grouping.move([first]))
        expect(AudioUnitGroups.children(project.rootBox).indexOf(first)).toBeGreaterThan(AudioUnitGroups.children(project.rootBox).indexOf(fx))
        const folder = asDefined(project.editing.modify(() => project.grouping.create([first, second, fx]).unwrap()).unwrap())
        project.editing.modify(() => project.grouping.move([third], folder))
        expectOrder(AudioUnitGroups.children(project.rootBox, folder), [second, fx, first, third])
        const copies = project.editing.modify(() => project.grouping.duplicate([first, fx])).unwrap()
        expectOrder(AudioUnitGroups.children(project.rootBox, folder), [second, fx, first, copies[0], copies[1], third])
        expect(project.editing.undo()).toBe(true)
        expectOrder(AudioUnitGroups.children(project.rootBox, folder), [second, fx, first, third])
        expect(project.editing.redo()).toBe(true)
        expectOrder(AudioUnitGroups.children(project.rootBox, folder), [second, fx, first, copies[0], copies[1], third])
        project.terminate()
    })
    it("pastes a channel after the selected track inside its group, routed to that group", async () => {
        const {project, units: [first, second, outside]} = await setup()
        const folder = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        const handler = AudioUnitsClipboard.createHandler({
            getEnabled: () => true, editing: project.editing, boxGraph: project.boxGraph,
            rootBoxAdapter: project.rootBoxAdapter, audioUnitEditing: project.userEditingManager.audioUnit,
            getEditedAudioUnit: () => Option.wrap(project.boxAdapters.adapterFor(outside, AudioUnitBoxAdapter)),
            placePasted: unit => {
                project.api.placeAudioUnitsAt([unit], project.api.insertionAfterSelection())
                select(project, [unit])
            }
        })
        const entry = handler.copy().unwrap()
        select(project, [first])
        handler.paste(entry)
        const [pasted] = project.audioUnitSelection.selected()
        expectOrder(AudioUnitGroups.children(project.rootBox, folder), [first, pasted, second])
        expect(AudioUnitGroups.parent(pasted).unwrapOrUndefined()).toBe(folder)
        handler.paste(entry)
        const [next] = project.audioUnitSelection.selected()
        expectOrder(AudioUnitGroups.children(project.rootBox, folder), [first, pasted, next, second])
        project.editing.undo()
        project.editing.undo()
        expectOrder(AudioUnitGroups.children(project.rootBox, folder), [first, second])
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("preserves existing hierarchy when pasting a channel and disables folder copy/cut", async () => {
        const {project, units: [first, second, outside]} = await setup()
        const folder = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        let edited = project.boxAdapters.adapterFor(outside, AudioUnitBoxAdapter)
        const handler = AudioUnitsClipboard.createHandler({
            getEnabled: () => true, editing: project.editing, boxGraph: project.boxGraph,
            rootBoxAdapter: project.rootBoxAdapter, audioUnitEditing: project.userEditingManager.audioUnit,
            getEditedAudioUnit: () => Option.wrap(edited)
        })
        const before = AudioUnitGroups.ordered(project.rootBox)
        handler.paste(handler.copy().unwrap())
        const ordered = AudioUnitGroups.ordered(project.rootBox)
        const pasted = asDefined(ordered.find(unit => !before.includes(unit)))
        expect(ordered.filter(unit => unit !== pasted)).toEqual(before)
        expect(ordered.indexOf(pasted)).toBe(ordered.indexOf(outside) + 1)
        expect(AudioUnitGroups.subtree(project.rootBox, folder)).toEqual([folder, first, second])
        edited = project.boxAdapters.adapterFor(folder, AudioUnitBoxAdapter)
        expect(handler.canCopy({clientX: 0, clientY: 0})).toBe(false)
        expect(handler.canCut({clientX: 0, clientY: 0})).toBe(false)
        project.terminate()
    })
    it("keeps instruments before FX buses when moving and creating channels", async () => {
        const {project, units: [, , , last]} = await setup()
        const bus = project.editing.modify(() => AudioBusFactory.create(project.skeleton,
            "Bus", IconSymbol.Folder, AudioUnitType.Bus, Colors.blue)).unwrap()
        const busUnit = asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox)
        project.editing.modify(() => project.grouping.move([last]))
        const before = AudioUnitGroups.ordered(project.rootBox)
        expect(before.indexOf(last)).toBeGreaterThan(before.indexOf(busUnit))
        const created = project.editing.modify(() =>
            project.api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox).unwrap()
        expect(AudioUnitGroups.ordered(project.rootBox).filter(unit => unit !== created)).toEqual(before)
        expect(AudioUnitGroups.ordered(project.rootBox).at(-1)).toBe(project.primaryAudioUnitBox)
        project.terminate()
    })
    it("preserves custom and disconnected outputs during plain reorders and undo", async () => {
        const {project, units: [custom, disconnected, first, second]} = await setup()
        const bus = project.editing.modify(() => AudioBusFactory.create(project.skeleton,
            "Custom", IconSymbol.AudioBus, AudioUnitType.Bus, Colors.blue)).unwrap()
        project.editing.modify(() => {
            custom.output.refer(bus.input)
            disconnected.output.defer()
        })
        const before = AudioUnitGroups.ordered(project.rootBox)
        const route = custom.output.targetAddress.unwrap()
        project.editing.modify(() => project.grouping.move([custom, disconnected], undefined, second))
        expectOrder(AudioUnitGroups.children(project.rootBox), [first, custom, disconnected, second,
            asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox), project.primaryAudioUnitBox])
        expect(custom.output.targetAddress.unwrap().equals(route)).toBe(true)
        expect(disconnected.output.targetAddress.isEmpty()).toBe(true)
        expect(project.editing.undo()).toBe(true)
        expectOrder(AudioUnitGroups.ordered(project.rootBox), before)
        expect(custom.output.targetAddress.unwrap().equals(route)).toBe(true)
        expect(disconnected.output.targetAddress.isEmpty()).toBe(true)
        project.terminate()
    })
    it("keeps ordinary bus creation behind instruments without touching their indices", async () => {
        const {project, units} = await setup()
        const writes = vi.fn()
        const subscriptions = units.map(unit => unit.index.subscribe(writes))
        const bus = project.editing.modify(() => AudioBusFactory.create(project.skeleton,
            "Bus", IconSymbol.AudioBus, AudioUnitType.Bus, Colors.blue)).unwrap()
        expectOrder(AudioUnitGroups.children(project.rootBox), [...units,
            asInstanceOf(bus.output.targetVertex.unwrap().box, AudioUnitBox), project.primaryAudioUnitBox])
        expect(writes).not.toHaveBeenCalled()
        subscriptions.forEach(subscription => subscription.terminate())
        project.terminate()
    })
    it("drops a deleted track from the selection and groups nothing without a selection", async () => {
        const {project, units: [first, second]} = await setup()
        select(project, [first, second])
        project.editing.modify(() => second.delete())
        expectSelected(project, [first])
        expect(project.editing.undo()).toBe(true)
        expect(project.boxGraph.findBox(second.address.uuid).nonEmpty()).toBe(true)
        select(project, [])
        project.userEditingManager.audioUnit.edit(first.editing)
        expect(project.grouping.create(project.audioUnitSelection.selected()).isEmpty()).toBe(true)
        expect(AudioUnitGroups.parent(first).isEmpty()).toBe(true)
        project.terminate()
    })
    it("undoes a selection change together with the grouping that follows it", async () => {
        const {project, units: [first, second, third]} = await setup()
        select(project, [first, second])
        const group = project.editing.modify(() => project.grouping.create(project.audioUnitSelection.selected()).unwrap()).unwrap()
        expectSelected(project, [first, second])
        expect(project.editing.undo()).toBe(true)
        expect(group.isAttached()).toBe(false)
        expectSelected(project, [])
        expect(project.editing.redo()).toBe(true)
        expectSelected(project, [first, second])
        expect(project.audioUnitSelection.isSelected(third)).toBe(false)
        project.terminate()
    })
    it("expands group transfers only when explicitly requested", async () => {
        const {project, units: [first, second]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap()
        const copies = project.editing.modify(() => TransferAudioUnits.transfer([group], project.skeleton)).unwrap()
        expect(copies).toHaveLength(1)
        expect(AudioUnitGroups.children(project.rootBox, copies[0])).toHaveLength(0)
        expect(project.editing.undo()).toBe(true)
        expect(project.editing.modify(() => project.grouping.duplicate([group])).unwrap()).toHaveLength(1)
        expectSelected(project, [])
        project.terminate()
    })
    it("changes the audio route when moving into and out of a group", async () => {
        const {project, units: [source, destination, member]} = await setup()
        const custom = project.editing.modify(() => project.grouping.create([destination]).unwrap()).unwrap()
        const folder = project.editing.modify(() => project.grouping.create([member]).unwrap()).unwrap()
        expect(custom).toBeDefined()
        expect(folder).toBeDefined()
        const bus = AudioUnitGroups.bus(custom!).unwrapOrUndefined()!
        project.editing.modify(() => source.output.refer(bus.input))
        project.editing.modify(() => project.grouping.move([source], folder))
        expect(source.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(folder!).unwrapOrUndefined())
        expect(AudioUnitGroups.parent(source).unwrapOrUndefined()).toBe(folder)
        project.editing.modify(() => project.grouping.move([source]))
        expect(source.output.targetVertex.unwrap().box).toBe(project.primaryAudioBusBox)
        expect(AudioUnitGroups.parent(source).unwrapOrUndefined()).toBeUndefined()
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("derives membership, visibility and one layout publication from output-menu edits", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        const group = asDefined(project.editing.modify(() => project.grouping.create([first]).unwrap()).unwrap())
        project.editing.modify(() => group.groupCollapsed.setValue(true))
        const notify = vi.fn()
        const subscription = project.audioUnitLayout.value.subscribe(notify)
        project.editing.modify(() => {
            second.output.refer(asDefined(AudioUnitGroups.bus(group).unwrapOrUndefined()).input)
            third.output.refer(asDefined(AudioUnitGroups.bus(group).unwrapOrUndefined()).input)
        })
        expect(notify).toHaveBeenCalledTimes(1)
        expectOrder(AudioUnitGroups.children(project.rootBox, group), [first, second, third])
        expect(project.audioUnitLayout.snapshot.row(second).unwrap().parent).toBe(group)
        expect(project.audioUnitLayout.snapshot.row(second).unwrap().visibleIndex).toBe(-1)
        expect(AudioUnitGroups.parent(fourth).unwrapOrUndefined()).toBeUndefined()
        expect(project.editing.undo()).toBe(true)
        expect(notify).toHaveBeenCalledTimes(2)
        expect(AudioUnitGroups.parent(second).unwrapOrUndefined()).toBeUndefined()
        expect(project.audioUnitLayout.snapshot.row(second).unwrap().visibleIndex).toBeGreaterThanOrEqual(0)
        expect(project.editing.redo()).toBe(true)
        expect(notify).toHaveBeenCalledTimes(3)
        expect(AudioUnitGroups.parent(second).unwrapOrUndefined()).toBe(group)
        project.editing.modify(() => second.output.defer())
        expect(AudioUnitGroups.parent(second).unwrapOrUndefined()).toBeUndefined()
        expect(project.audioUnitLayout.snapshot.row(second).unwrap().parent).toBeUndefined()
        project.boxGraph.verifyPointers()
        subscription.terminate()
        project.terminate()
    })
    it("does not turn aux sends or ordinary bus routes into folder membership", async () => {
        const {project, units: [first, second]} = await setup()
        const group = asDefined(project.editing.modify(() => project.grouping.create([first]).unwrap()).unwrap())
        const ordinary = project.editing.modify(() => AudioBusFactory.create(project.skeleton,
            "Ordinary bus", IconSymbol.AudioBus, AudioUnitType.Bus, Colors.blue)).unwrap()
        project.editing.modify(() => {
            AuxSendBox.create(project.boxGraph, UUID.generate(), send => {
                send.audioUnit.refer(second.auxSends)
                send.targetBus.refer(asDefined(AudioUnitGroups.bus(group).unwrapOrUndefined()).input)
            })
            second.output.refer(ordinary.input)
        })
        expectOrder(AudioUnitGroups.children(project.rootBox, group), [first])
        expect(AudioUnitGroups.parent(second).unwrapOrUndefined()).toBeUndefined()
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("rejects output-menu routing through self, descendants and feedback sends", async () => {
        const {project, units: [first, second, third]} = await setup()
        const group = asDefined(project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap())
        const inner = asDefined(project.editing.modify(() => project.grouping.create([second]).unwrap()).unwrap())
        expect(project.grouping.canRoute([group], group)).toBe(false)
        expect(project.grouping.canRoute([group], inner)).toBe(false)
        expect(project.grouping.canRoute([first], inner)).toBe(true)
        expect(project.grouping.canRoute([inner], project.primaryAudioUnitBox)).toBe(true)
        const other = asDefined(project.editing.modify(() => project.grouping.create([third]).unwrap()).unwrap())
        project.editing.modify(() => AuxSendBox.create(project.boxGraph, UUID.generate(), send => {
            send.audioUnit.refer(group.auxSends)
            send.targetBus.refer(asDefined(AudioUnitGroups.bus(other).unwrapOrUndefined()).input)
        }))
        expect(project.grouping.canRoute([other], group)).toBe(false)
        expect(project.grouping.canMove([other], group)).toBe(false)
        project.terminate()
    })
    it("keeps existing folder order during transfers and ignores unrelated channels in subtree queries", async () => {
        const {project, units: [first, second, third, fourth]} = await setup()
        const folder = project.editing.modify(() => project.grouping.create([first, second]).unwrap()).unwrap()!
        const before = AudioUnitGroups.ordered(project.rootBox)
        const [copy] = project.editing.modify(() => TransferAudioUnits.transfer([fourth], project.skeleton)).unwrap()
        expect(AudioUnitGroups.ordered(project.rootBox).filter(unit => unit !== copy)).toEqual(before)
        const incoming = vi.spyOn(project.rootBox.audioUnits.pointerHub, "incoming")
        expect(AudioUnitGroups.subtree(project.rootBox, folder)).toEqual([folder, first, second])
        expect(incoming).not.toHaveBeenCalled()
        incoming.mockRestore()
        expect(third.isAttached()).toBe(true)
        project.terminate()
    })
    it("duplicates a child independently without leaving a stale original folder reference", async () => {
        const {project, units: [a]} = await setup()
        project.editing.modify(() => project.grouping.create([a]).unwrap())
        const [copy] = project.editing.modify(() => TransferAudioUnits.transfer([a], project.skeleton)).unwrap()
        expect(AudioUnitGroups.parent(copy).unwrapOrUndefined()).toBeUndefined()
        expect(copy.output.targetVertex.unwrap().box).toBe(project.primaryAudioBusBox)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("numbers new and duplicated group names that are already taken", async () => {
        const {project, units: [a, b, c]} = await setup()
        const label = (group: AudioUnitBox): string => AudioUnitGroups.bus(group).unwrap().label.getValue()
        const first = project.editing.modify(() => project.grouping.create([a]).unwrap()).unwrap()
        const second = project.editing.modify(() => project.grouping.create([b]).unwrap()).unwrap()
        const outer = project.editing.modify(() => project.grouping.create([second, c]).unwrap()).unwrap()
        expect([label(first), label(second), label(outer)]).toEqual(["Group", "Group 2", "Group 3"])
        project.editing.modify(() => AudioUnitGroups.bus(first).unwrap().label.setValue("Mid"))
        const [copy] = project.editing.modify(() => project.grouping.duplicate([first])).unwrap()
        const [nextCopy] = project.editing.modify(() => project.grouping.duplicate([copy])).unwrap()
        expect([label(first), label(copy), label(nextCopy)]).toEqual(["Mid", "Mid 2", "Mid 3"])
        const [outerCopy] = project.editing.modify(() => project.grouping.duplicate([outer])).unwrap()
        const innerCopy = AudioUnitGroups.children(project.rootBox, outerCopy).find(unit => unit.isGroup.getValue())
        expect([label(outerCopy), label(asDefined(innerCopy))]).toEqual(["Group 4", "Group 5"])
        project.editing.modify(() => AudioUnitGroups.bus(first).unwrap().label.setValue("Mix 2024"))
        const [yearCopy] = project.editing.modify(() => project.grouping.duplicate([first])).unwrap()
        const [nextYearCopy] = project.editing.modify(() => project.grouping.duplicate([yearCopy])).unwrap()
        expect([label(yearCopy), label(nextYearCopy)]).toEqual(["Mix 2024 2", "Mix 2024 3"])
        project.terminate()
    })
    it("duplicates a top-level track immediately after its source and supports undo/redo", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const [copy] = project.editing.modify(() => project.grouping.duplicate([b])).unwrap()
        expectOrder(AudioUnitGroups.children(project.rootBox), [a, b, copy, c, d, project.primaryAudioUnitBox])
        expect(copy.output.targetVertex.unwrap().box).toBe(b.output.targetVertex.unwrap().box)
        project.editing.undo()
        expectOrder(AudioUnitGroups.children(project.rootBox), [a, b, c, d, project.primaryAudioUnitBox])
        project.editing.redo()
        const restored = asInstanceOf(project.boxGraph.findBox(copy.address.uuid).unwrap(), AudioUnitBox)
        expectOrder(AudioUnitGroups.children(project.rootBox), [a, b, restored, c, d, project.primaryAudioUnitBox])
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("duplicates a child immediately after its source inside the same nested group", async () => {
        const {project, units: [a, b, c]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c]).unwrap()).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        const [copy] = project.editing.modify(() => project.grouping.duplicate([a])).unwrap()
        expectOrder(AudioUnitGroups.children(project.rootBox, inner), [a, copy, b])
        expect(AudioUnitGroups.parent(copy).unwrapOrUndefined()).toBe(inner)
        expect(copy.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(inner).unwrapOrUndefined())
        expectOrder(AudioUnitGroups.children(project.rootBox, outer), [inner, c])
        const decoded = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        const loadedCopy = decoded.boxGraph.findBox(copy.address.uuid).unwrap() as typeof copy
        expect(AudioUnitGroups.parent(loadedCopy).unwrapOrUndefined()?.address.equals(inner.address)).toBe(true)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("duplicates a reversed noncontiguous selection as a block after the last selected sibling", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const [copyA, copyC] = project.editing.modify(() => project.grouping.duplicate([c, a])).unwrap()
        expectOrder(AudioUnitGroups.children(project.rootBox), [a, b, c, copyA, copyC, d, project.primaryAudioUnitBox])
        project.terminate()
    })
    it("duplicates nested subtrees only once and places cross-folder selections in their own folders", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c]).unwrap()).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        const [copyInner, copyC, copyD] = project.editing.modify(() => project.grouping.duplicate([d, a, inner, c])).unwrap()
        expectOrder(AudioUnitGroups.children(project.rootBox, outer), [inner, c, copyInner, copyC])
        expectOrder(AudioUnitGroups.children(project.rootBox), [outer, d, copyD, project.primaryAudioUnitBox])
        const children = AudioUnitGroups.children(project.rootBox, copyInner)
        expect(children).toHaveLength(2)
        expect(AudioUnitGroups.parent(copyInner).unwrapOrUndefined()).toBe(outer)
        expect(copyInner.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(outer).unwrapOrUndefined())
        expect(children.every(child => child.output.targetVertex.unwrap().box === AudioUnitGroups.bus(copyInner).unwrapOrUndefined())).toBe(true)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("groups selections from different nested folders under their closest common parent", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c, d]).unwrap()).unwrap()
        const left = project.editing.modify(() => project.grouping.create([a]).unwrap()).unwrap()
        const right = project.editing.modify(() => project.grouping.create([b]).unwrap()).unwrap()
        const combined = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        expect(AudioUnitGroups.parent(combined).unwrapOrUndefined()).toBe(outer)
        expectOrder(AudioUnitGroups.children(project.rootBox, combined), [a, b])
        expectOrder(AudioUnitGroups.children(project.rootBox, outer), [combined, left, right, c, d])
        expect(AudioUnitGroups.parent(c).unwrapOrUndefined()).toBe(outer)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("duplicates a nested group with independent children and internal audio routes", async () => {
        const {project, units: [a, b]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        project.editing.modify(() => project.grouping.create([b]).unwrap())
        const copies = project.editing.modify(() => TransferAudioUnits.transfer([group], project.skeleton, {includeGroupDescendants: true})).unwrap()
        const copy = copies[0]
        expect(copy).not.toBe(group)
        expect(copy.isGroup.getValue()).toBe(true)
        const children = AudioUnitGroups.children(project.rootBox, copy)
        expect(children.length).toBe(2)
        expect(children[0].output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(copy).unwrapOrUndefined())
        const inner = children.find(unit => unit.isGroup.getValue())!
        const leaf = AudioUnitGroups.children(project.rootBox, inner)[0]
        expect(leaf.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(inner).unwrapOrUndefined())
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("places a group at its first selected track, routes through unity, and keeps instruments and clips", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([b, c]).unwrap()).unwrap()
        expectOrder(AudioUnitGroups.ordered(project.rootBox), [a, group, b, c, d, project.primaryAudioUnitBox])
        expectOrder(AudioUnitGroups.children(project.rootBox, group), [b, c])
        expect(group.volume.getValue()).toBe(0)
        expect(b.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(group).unwrapOrUndefined())
        expect(b.input.pointerHub.incoming()[0].box.name).toBe("VaporisateurDeviceBox")
        const adapter = project.boxAdapters.adapterFor(group, AudioUnitBoxAdapter)
        expect(DeviceHost.takesEffect(adapter, "audio")).toBe(true)
        expect(DeviceHost.takesEffect(adapter, "midi")).toBe(false)
        expect(adapter.hostsInstrument).toBe(false)
        const fx = project.editing.modify(() => project.api.insertEffect(group.audioEffects, EffectFactories.AudioNamed.Delay)).unwrap()
        expect(fx.isAttached()).toBe(true)
        project.terminate()
    })
    it("moves into a precise nested slot, moves out, and rejects descendant/feedback cycles", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c]).unwrap()).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([b]).unwrap()).unwrap()
        expect(AudioUnitGroups.parent(inner).unwrapOrUndefined()).toBe(outer)
        expect(inner.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(outer).unwrapOrUndefined())
        project.editing.modify(() => project.grouping.move([d], inner, b))
        expectOrder(AudioUnitGroups.children(project.rootBox, inner), [d, b])
        expect(project.grouping.canMove([outer], inner)).toBe(false)
        expect(project.grouping.canMove([inner], inner)).toBe(false)
        expect(project.grouping.canMove([project.primaryAudioUnitBox], inner)).toBe(false)
        project.editing.modify(() => project.grouping.move([d], undefined, outer))
        expect(AudioUnitGroups.parent(d).unwrapOrUndefined()).toBeUndefined()
        expect(d.output.targetVertex.unwrap().box).toBe(project.primaryAudioBusBox)
        expectOrder(AudioUnitGroups.children(project.rootBox), [d, outer, project.primaryAudioUnitBox])
        // independent audio route from the target back to source is rejected too
        project.editing.modify(() => inner.output.refer(AudioUnitGroups.bus(outer).unwrapOrUndefined()!.input))
        expect(project.grouping.canMove([outer], inner)).toBe(false)
        project.terminate()
    })
    it("moves a selected group and child only once and keeps their subtree contiguous", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        project.editing.modify(() => project.grouping.move([a, group], undefined))
        expectOrder(AudioUnitGroups.ordered(project.rootBox), [c, d, group, a, b, project.primaryAudioUnitBox])
        project.terminate()
    })
    it("collapse survives project serialization and never changes audio routes", async () => {
        const {project, units: [a, b]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        project.editing.modify(() => {
            group.groupCollapsed.setValue(true)
            group.userInterface.height.setValue(132)
        })
        expect(AudioUnitGroups.hidden(a)).toBe(true)
        const loaded = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        const loadedGroup = loaded.boxGraph.findBox(group.address.uuid).unwrap() as typeof group
        const loadedA = loaded.boxGraph.findBox(a.address.uuid).unwrap() as typeof a
        expect(loadedGroup.groupCollapsed.getValue()).toBe(true)
        expect(loadedGroup.userInterface.height.getValue()).toBe(132)
        expect(AudioUnitGroups.parent(loadedA).unwrapOrUndefined()).toBe(loadedGroup)
        expect(loadedA.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(loadedGroup).unwrapOrUndefined())
        project.terminate()
    })
    it("deleting a collapsed group removes its full subtree and content, with undo/redo", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([b]).unwrap()).unwrap()
        const content = project.editing.modify(() => {
            const track = project.boxAdapters.adapterFor(b, AudioUnitBoxAdapter).tracks.values()[0].box
            const clip = project.api.createNoteClip(track, 0)
            const region = project.api.createNoteRegion({trackBox: track, position: 0, duration: 960})
            const effect = project.api.insertEffect(group.audioEffects, EffectFactories.AudioNamed.StereoTool)
            group.groupCollapsed.setValue(true)
            return [track, clip, region, effect]
        }).unwrap()
        const removed = [group, inner, a, b, AudioUnitGroups.bus(group).unwrapOrUndefined()!, AudioUnitGroups.bus(inner).unwrapOrUndefined()!, ...content]
            .map(box => box.address.uuid)
        project.editing.modify(() => project.api.deleteAudioUnit(group))
        expect(removed.every(uuid => project.boxGraph.findBox(uuid).isEmpty())).toBe(true)
        expectOrder(AudioUnitGroups.ordered(project.rootBox), [c, d, project.primaryAudioUnitBox])
        project.boxGraph.verifyPointers()
        expect(project.editing.undo()).toBe(true)
        expect(removed.every(uuid => project.boxGraph.findBox(uuid).nonEmpty())).toBe(true)
        const restored = project.boxGraph.findBox(group.address.uuid).unwrap() as typeof group
        const restoredInner = project.boxGraph.findBox(inner.address.uuid).unwrap() as typeof inner
        const restoredB = project.boxGraph.findBox(b.address.uuid).unwrap() as typeof b
        expect(restored.groupCollapsed.getValue()).toBe(true)
        expect(AudioUnitGroups.parent(restoredInner).unwrapOrUndefined()).toBe(restored)
        expect(AudioUnitGroups.parent(restoredB).unwrapOrUndefined()).toBe(restoredInner)
        expect(restoredB.output.targetVertex.unwrap().box).toBe(AudioUnitGroups.bus(restoredInner).unwrapOrUndefined())
        project.boxGraph.verifyPointers()
        expect(project.editing.redo()).toBe(true)
        expect(removed.every(uuid => project.boxGraph.findBox(uuid).isEmpty())).toBe(true)
        expectOrder(AudioUnitGroups.ordered(project.rootBox), [c, d, project.primaryAudioUnitBox])
        project.terminate()
    })
    it("deleting an inner group preserves its parent, siblings, and outside tracks", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const outer = project.editing.modify(() => project.grouping.create([a, b, c]).unwrap()).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        project.editing.modify(() => project.api.deleteAudioUnit(inner))
        expectOrder(AudioUnitGroups.children(project.rootBox, outer), [c])
        expectOrder(AudioUnitGroups.ordered(project.rootBox), [outer, c, d, project.primaryAudioUnitBox])
        expect([a, b, inner].every(unit => project.boxGraph.findBox(unit.address.uuid).isEmpty())).toBe(true)
        project.boxGraph.verifyPointers()
        project.terminate()
    })
    it("ungroup keeps children and nested groups and supports undo/redo", async () => {
        const {project, units: [a, b, c, d]} = await setup()
        const group = project.editing.modify(() => project.grouping.create([a, b]).unwrap()).unwrap()
        const inner = project.editing.modify(() => project.grouping.create([b]).unwrap()).unwrap()
        project.editing.modify(() => project.grouping.ungroup(group))
        expect(AudioUnitGroups.parent(a).unwrapOrUndefined()).toBeUndefined()
        expect(AudioUnitGroups.parent(inner).unwrapOrUndefined()).toBeUndefined()
        expect(AudioUnitGroups.parent(b).unwrapOrUndefined()).toBe(inner)
        expectOrder(AudioUnitGroups.ordered(project.rootBox), [a, inner, b, c, d, project.primaryAudioUnitBox])
        expect(project.editing.undo()).toBe(true)
        const restored = project.boxGraph.findBox(group.address.uuid).unwrap() as typeof group
        expect(AudioUnitGroups.children(project.rootBox, restored).length).toBe(2)
        expect(project.editing.redo()).toBe(true)
        expect(project.boxGraph.findBox(group.address.uuid).isEmpty()).toBe(true)
        project.terminate()
    })

})
