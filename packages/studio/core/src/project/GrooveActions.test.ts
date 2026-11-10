import {describe, expect, it} from "vitest"
import {asInstanceOf, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    GrooveBox, Grooves, InstrumentFactories, NoteRegionBoxAdapter, ProjectSkeleton, ValueRegionBoxAdapter, ZeitgeistDeviceBoxAdapter
} from "@opendaw/studio-adapters"
import {
    CubedDeviceBox,
    GrooveFunctionBox,
    GrooveOffsetBox,
    NoteEventBox,
    NoteEventCollectionBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    GrooveRandomBox,
    GrooveShuffleBox,
    GrooveStackBox,
    GrooveStackEntryBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {EffectFactories} from "../EffectFactories"
import {Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {migrateGrooveCollection} from "./migration/MigrateGrooveCollection"
import {migrateZeitgeistDeviceBox} from "./migration/MigrateZeitgeistDeviceBox"
import type {ProjectEnv} from "./ProjectEnv"
import type {Project} from "./Project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const labels = (project: Project): ReadonlyArray<string> =>
    project.rootBoxAdapter.grooves.adapters().map(adapter => adapter.label)

const indices = (project: Project): ReadonlyArray<number> =>
    project.rootBoxAdapter.grooves.adapters().map(adapter => adapter.indexField.getValue())

const createZeitgeist = (project: Project): ZeitgeistDeviceBox => project.editing.modify(() => {
    const {audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
    return project.api.insertEffect(audioUnitBox.midiEffects, EffectFactories.MidiNamed.Zeitgeist) as ZeitgeistDeviceBox
}).unwrap()

const targetOf = (zeitgeist: ZeitgeistDeviceBox) => zeitgeist.groove.targetVertex.map(vertex => vertex.box)

describe("Grooves", () => {
    it("a new project lists the global shuffle first", async () => {
        const project = await createProject()
        expect(labels(project)).toEqual(["Global Shuffle"])
        const global = Grooves.globalGroove(project) as GrooveShuffleBox
        expect(global).toBeInstanceOf(GrooveShuffleBox)
        expect(global.duration.getValue()).toBe(480)
        expect(Grooves.isGlobal(project, global)).toBe(true)
    })
    it("a new Zeitgeist uses the global shuffle", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        expect(targetOf(zeitgeist).unwrap()).toBe(Grooves.globalGroove(project))
        expect(labels(project)).toEqual(["Global Shuffle"])
    })
    it("a Zeitgeist without a groove has an adapter and no groove", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        project.editing.modify(() => zeitgeist.groove.defer())
        const adapter = project.boxAdapters.adapterFor(zeitgeist, ZeitgeistDeviceBoxAdapter)
        expect(adapter.groove().isEmpty()).toBe(true)
        const seen: Array<boolean> = []
        const subscription = adapter.catchupAndSubscribeGroove(groove => seen.push(groove.nonEmpty()))
        project.editing.modify(() => zeitgeist.groove.refer(Grooves.globalGroove(project)))
        subscription.terminate()
        expect(seen).toEqual([false, true])
    })
    it("creates every kind with a unique label at the end of the list", async () => {
        const project = await createProject()
        project.editing.modify(() => Grooves.Kinds.forEach(({kind}) => Grooves.create(project, kind)))
        project.editing.modify(() => Grooves.create(project, "power"))
        expect(labels(project))
            .toEqual(["Global Shuffle", "Shuffle", "Power", "S-Curve", "Random", "Offset", "Stack", "Power 2"])
        expect(indices(project)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        expect(project.rootBoxAdapter.grooves.adapters().map(adapter => adapter.kind))
            .toEqual(["shuffle", "shuffle", "power", "s-curve", "random", "offset", "stack", "power"])
    })
    it("replace keeps users, label, index, amount and duration", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        const groove = project.editing.modify(() => Grooves.create(project, "shuffle", "Mine")).unwrap() as GrooveShuffleBox
        project.editing.modify(() => {
            groove.amount.setValue(0.8)
            groove.duration.setValue(960)
            zeitgeist.groove.refer(groove)
        })
        const replaced = project.editing.modify(() => Grooves.replace(project, groove, "random")).unwrap()
        expect(replaced).toBeInstanceOf(GrooveRandomBox)
        expect(groove.isAttached()).toBe(false)
        expect(targetOf(zeitgeist).unwrap()).toBe(replaced)
        expect(labels(project)).toEqual(["Global Shuffle", "Mine"])
        const random = replaced as GrooveRandomBox
        expect(random.amount.getValue()).toBeCloseTo(0.8)
        expect(random.duration.getValue()).toBe(960)
    })
    it("replace between power and s-curve keeps the box", async () => {
        const project = await createProject()
        const groove = project.editing.modify(() => Grooves.create(project, "power")).unwrap()
        const replaced = project.editing.modify(() => Grooves.replace(project, groove, "s-curve")).unwrap()
        expect(replaced).toBe(groove)
        expect(Grooves.kindOf(replaced)).toBe("s-curve")
    })
    it("the global groove can change its type and is never deleted", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        const global = Grooves.globalGroove(project)
        project.editing.modify(() => Grooves.deleteAll(project, [global], "remove"))
        expect(global.isAttached()).toBe(true)
        const replaced = project.editing.modify(() => Grooves.replace(project, global, "random")).unwrap()
        expect(Grooves.globalGroove(project)).toBe(replaced)
        expect(Grooves.isGlobal(project, replaced)).toBe(true)
        expect(targetOf(zeitgeist).unwrap()).toBe(replaced)
        expect(labels(project)).toEqual(["Global Shuffle"])
    })
    it("make unique gives one user its own copy", async () => {
        const project = await createProject()
        const first = createZeitgeist(project)
        const second = createZeitgeist(project)
        const global = Grooves.globalGroove(project) as GrooveShuffleBox
        project.editing.modify(() => global.amount.setValue(0.7))
        const copy = project.editing.modify(() => Grooves.makeUnique(project, global, first.groove)).unwrap()
        expect(targetOf(first).unwrap()).toBe(copy)
        expect(targetOf(second).unwrap()).toBe(global)
        expect((copy as GrooveShuffleBox).amount.getValue()).toBeCloseTo(0.7)
        expect(labels(project)).toEqual(["Global Shuffle", "Global Shuffle 2"])
        expect(Grooves.users(copy).length).toBe(1)
    })
    it("deleting with fallback moves users to the global groove", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        const groove = project.editing.modify(() => Grooves.create(project, "power")).unwrap()
        project.editing.modify(() => zeitgeist.groove.refer(groove))
        project.editing.modify(() => Grooves.deleteAll(project, [groove], "fallback"))
        expect(targetOf(zeitgeist).unwrap()).toBe(Grooves.globalGroove(project))
        expect(labels(project)).toEqual(["Global Shuffle"])
    })
    it("deleting with fallback leaves a region and a clip without a groove", async () => {
        const project = await createProject()
        const groove = project.editing.modify(() => Grooves.create(project, "power")).unwrap()
        const [region, clip] = project.editing.modify(() => {
            const {trackBox} = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const region = project.api.createNoteRegion({trackBox, position: 0, duration: 960})
            const clip = project.api.createNoteClip(trackBox, 0)
            region.groove.refer(groove)
            clip.groove.refer(groove)
            return [region, clip] as const
        }).unwrap()
        project.editing.modify(() => Grooves.deleteAll(project, [groove], "fallback"))
        expect(region.groove.isEmpty()).toBe(true)
        expect(clip.groove.isEmpty()).toBe(true)
    })
    it("a new Cubed plays straight and deleting its groove with fallback leaves it without one", async () => {
        const project = await createProject()
        const groove = project.editing.modify(() => Grooves.create(project, "power")).unwrap()
        const cubed = project.editing.modify(() =>
            asInstanceOf(project.api.createAnyInstrument(InstrumentFactories.Cubed).instrumentBox, CubedDeviceBox)).unwrap()
        expect(cubed.groove.isEmpty()).toBe(true)
        project.editing.modify(() => cubed.groove.refer(groove))
        expect(Grooves.users(groove).length).toBe(1)
        project.editing.modify(() => Grooves.deleteAll(project, [groove], "fallback"))
        expect(cubed.groove.isEmpty()).toBe(true)
    })
    it("flattening keeps a groove only when every region shares it", async () => {
        const project = await createProject()
        const flatten = (grooves: ReadonlyArray<"late" | "none">) => {
            const late = project.editing.modify(() => Grooves.create(project, "offset")).unwrap()
            const regions = project.editing.modify(() => {
                const {trackBox} = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
                return grooves.map((groove, index) => {
                    const region = project.api.createNoteRegion({trackBox, position: index * 960, duration: 960})
                    if (groove === "late") {region.groove.refer(late)}
                    return region
                })
            }).unwrap()
            const adapters = regions.map(region => project.boxAdapters.adapterFor(region, NoteRegionBoxAdapter))
            // the studio marks selected regions, flatten works on them
            adapters.forEach(adapter => adapter.onSelected())
            const flat = project.editing.modify(() => adapters[0].flatten(adapters)).unwrap().unwrap("flatten")
            return flat.groove.targetVertex.map(vertex => vertex.box).match({none: () => null, some: box => box === late})
        }
        expect(flatten(["late", "late"])).toBe(true)
        expect(flatten(["late", "none"])).toBe(null)
        expect(flatten(["none", "late"])).toBe(null)
    })
    it("flattening with Apply Groove moves the notes where the groove plays them", async () => {
        const project = await createProject()
        const [region, late] = project.editing.modify(() => {
            const late = Grooves.create(project, "offset") as GrooveOffsetBox
            late.offset.setValue(120)
            const {trackBox} = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            // a region at bar 2 showing its content from the second beat, the groove runs from bar 2 minus a beat
            const region = project.api.createNoteRegion({trackBox, position: 3840, duration: 1920, loopOffset: 960, loopDuration: 3840})
            const events = asInstanceOf(region.events.targetVertex.unwrap().box, NoteEventCollectionBox)
            for (const position of [960, 1920, 2820]) {
                NoteEventBox.create(project.boxGraph, UUID.generate(), box => {
                    box.events.refer(events.events)
                    box.position.setValue(position)
                    box.duration.setValue(60)
                    box.pitch.setValue(60)
                })
            }
            region.groove.refer(late)
            return [region, late] as const
        }).unwrap()
        const adapter = project.boxAdapters.adapterFor(region, NoteRegionBoxAdapter)
        adapter.onSelected()
        const flat = project.editing.modify(() => adapter.flatten([adapter], false, "apply")).unwrap().unwrap("flatten")
        const notes = asInstanceOf(flat.events.targetVertex.unwrap().box, NoteEventCollectionBox).events.pointerHub.incoming()
            .map(pointer => asInstanceOf(pointer.box, NoteEventBox))
            .map(note => [note.position.getValue(), note.duration.getValue()])
            .sort((a, b) => a[0] - b[0])
        // straight at 0, 960 and 1860 of the flattened region, 120 later, the last moved past its end
        expect(notes).toEqual([[120, 60], [1080, 60]])
        expect(flat.groove.isEmpty()).toBe(true)
        expect(late.pointerHub.incoming().length).toBe(0)
    })
    it("flattening automation with Apply Groove moves its points", async () => {
        const project = await createProject()
        const region = project.editing.modify(() => {
            const late = Grooves.create(project, "offset") as GrooveOffsetBox
            late.offset.setValue(120)
            const {trackBox} = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const events = ValueEventCollectionBox.create(project.boxGraph, UUID.generate())
            ValueEventBox.create(project.boxGraph, UUID.generate(), box => {
                box.events.refer(events.events)
                box.position.setValue(0)
                box.value.setValue(0.25)
            })
            ValueEventBox.create(project.boxGraph, UUID.generate(), box => {
                box.events.refer(events.events)
                box.position.setValue(480)
                box.value.setValue(0.5)
                box.index.setValue(0)
            })
            return ValueRegionBox.create(project.boxGraph, UUID.generate(), box => {
                box.regions.refer(trackBox.regions)
                box.events.refer(events.owners)
                box.position.setValue(0)
                box.duration.setValue(1920)
                box.loopDuration.setValue(960)
                box.groove.refer(late)
            })
        }).unwrap()
        const adapter = project.boxAdapters.adapterFor(region, ValueRegionBoxAdapter)
        adapter.onSelected()
        const flat = project.editing.modify(() => adapter.flatten([adapter], false, "apply")).unwrap().unwrap("flatten")
        const points = asInstanceOf(flat.events.targetVertex.unwrap().box, ValueEventCollectionBox).events.pointerHub.incoming()
            .map(pointer => asInstanceOf(pointer.box, ValueEventBox))
            .map(point => [point.position.getValue(), point.index.getValue(), point.value.getValue()])
            .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        // every point moves 120 later, also the jump back to the loop start at the seam
        expect(points).toEqual([[120, 0, 0.25], [600, 0, 0.5], [1080, 0, 0.5], [1080, 1, 0.25], [1560, 0, 0.5], [2040, 0, 0.5]])
        expect(flat.groove.isEmpty()).toBe(true)
    })
    it("deleting with remove leaves users without a groove", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        const groove = project.editing.modify(() => Grooves.create(project, "power")).unwrap()
        project.editing.modify(() => zeitgeist.groove.refer(groove))
        project.editing.modify(() => Grooves.deleteAll(project, [groove], "remove"))
        expect(zeitgeist.isAttached()).toBe(true)
        expect(zeitgeist.groove.targetAddress.isEmpty()).toBe(true)
    })
    it("grooves created in one edit get their own index and label", async () => {
        const project = await createProject()
        const [first, second] = project.editing.modify(() =>
            [Grooves.create(project, "power", "Mine"), Grooves.create(project, "power", "Mine")]).unwrap()
        expect(second.index.getValue()).toBe(first.index.getValue() + 1)
        expect(second.label.getValue()).not.toBe(first.label.getValue())
    })
    it("deleting closes the index gaps", async () => {
        const project = await createProject()
        const [a, , c] = project.editing.modify(() =>
            [Grooves.create(project, "power"), Grooves.create(project, "random"), Grooves.create(project, "stack")]).unwrap()
        project.editing.modify(() => Grooves.deleteAll(project, [a, c], "remove"))
        expect(labels(project)).toEqual(["Global Shuffle", "Random"])
        expect(indices(project)).toEqual([0, 1])
    })
    it("a cycle of stacks from merged edits does not overflow", async () => {
        const project = await createProject()
        const [a, b, other] = project.editing.modify(() => {
            const a = Grooves.create(project, "stack") as GrooveStackBox
            const b = Grooves.create(project, "stack") as GrooveStackBox
            const other = Grooves.create(project, "power")
            // two peers each added one stack into the other
            GrooveStackEntryBox.create(project.boxGraph, UUID.generate(), box => {
                box.stack.refer(a.entries)
                box.groove.refer(b)
            })
            GrooveStackEntryBox.create(project.boxGraph, UUID.generate(), box => {
                box.stack.refer(b.entries)
                box.groove.refer(a)
            })
            return [a, b, other] as const
        }).unwrap()
        const c = project.editing.modify(() => Grooves.create(project, "stack") as GrooveStackBox).unwrap()
        expect(Grooves.canAddToStack(c, a)).toBe(true)
        expect(Grooves.wouldContain(a, b)).toBe(true)
        expect(Grooves.wouldContain(other, a)).toBe(false)
        const adapter = Grooves.adapterOf(project, a)
        expect(Number.isFinite(adapter.warp(123))).toBe(true)
        // listening to one of them does not chain the two into each other
        const subscription = adapter.subscribeChange(() => {})
        expect(() => project.editing.modify(() => (other as GrooveFunctionBox).amount.setValue(0.2))).not.toThrow()
        subscription.terminate()
        expect(Number.isFinite(adapter.cellDuration())).toBe(true)
        expect(() => project.editing.modify(() => Grooves.deleteAll(project, [b], "fallback"))).not.toThrow()
    })
    it("a stack follows its members again after its listeners left and came back", async () => {
        const project = await createProject()
        const [stack, member] = project.editing.modify(() => {
            const stack = Grooves.create(project, "stack") as GrooveStackBox
            const member = Grooves.create(project, "power") as GrooveFunctionBox
            Grooves.addToStack(project, stack, member)
            return [stack, member] as const
        }).unwrap()
        const adapter = Grooves.adapterOf(project, stack)
        let calls = 0
        const subscription = adapter.subscribeChange(() => calls++)
        project.editing.modify(() => member.amount.setValue(0.3))
        expect(calls).toBeGreaterThan(0)
        subscription.terminate()
        const again = adapter.subscribeChange(() => calls++)
        const before = calls
        project.editing.modify(() => member.amount.setValue(0.4))
        again.terminate()
        expect(calls).toBeGreaterThan(before)
    })
    it("a stack follows the other stack again once they no longer hold each other", async () => {
        const project = await createProject()
        const [a, b, power, backEntry] = project.editing.modify(() => {
            const a = Grooves.create(project, "stack") as GrooveStackBox
            const b = Grooves.create(project, "stack") as GrooveStackBox
            const power = Grooves.create(project, "power") as GrooveFunctionBox
            GrooveStackEntryBox.create(project.boxGraph, UUID.generate(), box => {
                box.stack.refer(a.entries)
                box.groove.refer(b)
                box.index.setValue(0)
            })
            Grooves.addToStack(project, b, power)
            // merged edits of two peers: b holds a as well
            const backEntry = GrooveStackEntryBox.create(project.boxGraph, UUID.generate(), box => {
                box.stack.refer(b.entries)
                box.groove.refer(a)
                box.index.setValue(1)
            })
            return [a, b, power, backEntry] as const
        }).unwrap()
        let calls = 0
        const subscription = Grooves.adapterOf(project, a).subscribeChange(() => calls++)
        project.editing.modify(() => Grooves.removeFromStack(backEntry))
        const before = calls
        project.editing.modify(() => power.amount.setValue(0.2))
        subscription.terminate()
        expect(b.isAttached()).toBe(true)
        expect(calls).toBeGreaterThan(before)
    })
        it("a stack never contains itself", async () => {
        const project = await createProject()
        const {outer, inner, power} = project.editing.modify(() => ({
            outer: Grooves.create(project, "stack") as GrooveStackBox,
            inner: Grooves.create(project, "stack") as GrooveStackBox,
            power: Grooves.create(project, "power")
        })).unwrap()
        project.editing.modify(() => {
            Grooves.addToStack(project, outer, inner)
            Grooves.addToStack(project, inner, power)
        })
        expect(Grooves.canAddToStack(outer, outer)).toBe(false)
        expect(Grooves.canAddToStack(inner, outer)).toBe(false)
        expect(Grooves.canAddToStack(outer, power)).toBe(true)
        project.editing.modify(() => Grooves.addToStack(project, inner, outer))
        expect(Grooves.entriesOf(inner).length).toBe(1)
    })
    it("a stack chains its members in order and reverses on unwarp", async () => {
        const project = await createProject()
        const {stack, power, scurve} = project.editing.modify(() => ({
            stack: Grooves.create(project, "stack") as GrooveStackBox,
            power: Grooves.create(project, "power") as GrooveFunctionBox,
            scurve: Grooves.create(project, "s-curve") as GrooveFunctionBox
        })).unwrap()
        project.editing.modify(() => {
            Grooves.addToStack(project, stack, power)
            Grooves.addToStack(project, stack, scurve)
        })
        const adapter = Grooves.adapterOf(project, stack)
        const first = Grooves.adapterOf(project, power)
        const second = Grooves.adapterOf(project, scurve)
        for (const position of [0, 100, 333, 480, 1000, 2500]) {
            expect(adapter.warp(position)).toBeCloseTo(second.warp(first.warp(position)), 9)
            expect(adapter.unwarp(adapter.warp(position))).toBeCloseTo(position, 3)
        }
    })
    it("removing a member from a stack deletes its entry and reindexes", async () => {
        const project = await createProject()
        const {stack, a, b} = project.editing.modify(() => ({
            stack: Grooves.create(project, "stack") as GrooveStackBox,
            a: Grooves.create(project, "power"),
            b: Grooves.create(project, "random")
        })).unwrap()
        project.editing.modify(() => {
            Grooves.addToStack(project, stack, a)
            Grooves.addToStack(project, stack, b)
        })
        project.editing.modify(() => Grooves.removeFromStack(Grooves.entriesOf(stack)[0]))
        const entries = Grooves.entriesOf(stack)
        expect(entries.length).toBe(1)
        expect(entries[0].index.getValue()).toBe(0)
        expect(entries[0].groove.targetVertex.unwrap().box).toBe(b)
    })
    it("a stack member moves to another place, the order changes the result", async () => {
        const project = await createProject()
        const {stack, a, b} = project.editing.modify(() => ({
            stack: Grooves.create(project, "stack") as GrooveStackBox,
            a: Grooves.create(project, "power"),
            b: Grooves.create(project, "s-curve")
        })).unwrap()
        project.editing.modify(() => {
            Grooves.addToStack(project, stack, a)
            Grooves.addToStack(project, stack, b)
        })
        const adapter = Grooves.adapterOf(project, stack)
        const before = adapter.warp(333)
        project.editing.modify(() => Grooves.moveInStack(stack, Grooves.entriesOf(stack)[1], 0))
        expect(Grooves.entriesOf(stack).map(entry => entry.groove.targetVertex.unwrap().box)).toEqual([b, a])
        expect(Grooves.entriesOf(stack).map(entry => entry.index.getValue())).toEqual([0, 1])
        expect(adapter.warp(333)).not.toBeCloseTo(before, 6)
        project.editing.modify(() => Grooves.moveInStack(stack, Grooves.entriesOf(stack)[0], -1))
        project.editing.modify(() => Grooves.moveInStack(stack, Grooves.entriesOf(stack)[0], 2))
        expect(Grooves.entriesOf(stack).map(entry => entry.groove.targetVertex.unwrap().box)).toEqual([b, a])
    })
    it("a stack spans the least common multiple of its members' durations", async () => {
        const project = await createProject()
        const {stack, a, b} = project.editing.modify(() => ({
            stack: Grooves.create(project, "stack") as GrooveStackBox,
            a: Grooves.create(project, "power") as GrooveFunctionBox,
            b: Grooves.create(project, "s-curve") as GrooveFunctionBox
        })).unwrap()
        project.editing.modify(() => {
            a.duration.setValue(1440)
            b.duration.setValue(960)
            Grooves.addToStack(project, stack, a)
            Grooves.addToStack(project, stack, b)
        })
        expect(Grooves.adapterOf(project, stack).cellDuration()).toBe(2880)
        project.editing.modify(() => Grooves.removeFromStack(Grooves.entriesOf(stack)[0]))
        expect(Grooves.adapterOf(project, stack).cellDuration()).toBe(960)
    })
    it("deleting a stack member removes its entry", async () => {
        const project = await createProject()
        const {stack, a} = project.editing.modify(() => ({
            stack: Grooves.create(project, "stack") as GrooveStackBox,
            a: Grooves.create(project, "power")
        })).unwrap()
        project.editing.modify(() => Grooves.addToStack(project, stack, a))
        project.editing.modify(() => Grooves.deleteAll(project, [a], "remove"))
        expect(Grooves.entriesOf(stack).length).toBe(0)
        expect(stack.isAttached()).toBe(true)
    })
    it("duplicating a stack copies its entries", async () => {
        const project = await createProject()
        const {stack, a} = project.editing.modify(() => ({
            stack: Grooves.create(project, "stack") as GrooveStackBox,
            a: Grooves.create(project, "power")
        })).unwrap()
        project.editing.modify(() => Grooves.addToStack(project, stack, a))
        const copy = project.editing.modify(() => Grooves.duplicate(project, stack)).unwrap() as GrooveStackBox
        expect(Grooves.entriesOf(copy).map(entry => entry.groove.targetVertex.unwrap().box)).toEqual([a])
        expect(Grooves.entriesOf(stack).length).toBe(1)
    })
    it("copying a Zeitgeist within the project keeps its groove", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        const groove = project.editing.modify(() => Grooves.create(project, "random")).unwrap()
        project.editing.modify(() => zeitgeist.groove.refer(groove))
        const host = zeitgeist.host.targetVertex.unwrap() as Field<Pointers.MIDIEffectHost>
        const copies = project.editing.modify(() =>
            project.api.copyEffects(host, [zeitgeist], 1)).unwrap() as ReadonlyArray<ZeitgeistDeviceBox>
        expect(copies.length).toBe(1)
        expect(targetOf(copies[0]).unwrap()).toBe(groove)
        expect(labels(project)).toEqual(["Global Shuffle", "Random"])
    })
    it("undo restores a replaced groove and its users", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        const groove = project.editing.modify(() => Grooves.create(project, "power")).unwrap()
        project.editing.modify(() => zeitgeist.groove.refer(groove))
        project.editing.modify(() => Grooves.replace(project, groove, "random"))
        project.editing.undo()
        const restored = targetOf(zeitgeist).unwrap()
        expect(restored).toBeInstanceOf(GrooveFunctionBox)
        expect(labels(project)).toEqual(["Global Shuffle", "Power"])
    })
})

describe("groove list migration", () => {
    const oldProject = () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
        const global = asInstanceOf(rootBox.groove.targetVertex.unwrap().box, GrooveShuffleBox)
        boxGraph.beginTransaction()
        global.collection.defer()
        const own = GrooveShuffleBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Shuffle")
            box.amount.setValue(0.7)
        })
        const second = GrooveShuffleBox.create(boxGraph, UUID.generate(), box => box.label.setValue("Shuffle"))
        boxGraph.endTransaction()
        return {boxGraph, rootBox, global, own, second}
    }
    it("puts the global groove first and every other groove after it with unique labels", () => {
        const {boxGraph, rootBox, global, own, second} = oldProject()
        expect(migrateGrooveCollection(boxGraph, rootBox)).toBe(true)
        const members = rootBox.grooves.pointerHub.incoming().map(pointer => pointer.box as GrooveBox)
            .sort((a, b) => a.index.getValue() - b.index.getValue())
        expect(members).toEqual([global, own, second])
        expect(members.map(box => box.label.getValue())).toEqual(["Global Shuffle", "Shuffle", "Shuffle 2"])
        expect(own.amount.getValue()).toBeCloseTo(0.7)
    })
    it("a list that already has members keeps the global groove first and the labels unique", () => {
        const {boxGraph, rootBox, global, own, second} = oldProject()
        boxGraph.beginTransaction()
        own.collection.refer(rootBox.grooves)
        own.index.setValue(0)
        boxGraph.endTransaction()
        expect(migrateGrooveCollection(boxGraph, rootBox)).toBe(false)
        const members = rootBox.grooves.pointerHub.incoming().map(pointer => asInstanceOf(pointer.box, GrooveShuffleBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
        expect(members).toEqual([global, own, second])
        expect(members.map(box => box.label.getValue())).toEqual(["Global Shuffle", "Shuffle", "Shuffle 2"])
    })
    it("runs once", () => {
        const {boxGraph, rootBox} = oldProject()
        migrateGrooveCollection(boxGraph, rootBox)
        expect(migrateGrooveCollection(boxGraph, rootBox)).toBe(false)
    })
    it("an empty Zeitgeist groove gets the global groove only in an old project", async () => {
        const project = await createProject()
        const zeitgeist = createZeitgeist(project)
        const global = Grooves.globalGroove(project)
        project.editing.modify(() => zeitgeist.groove.defer())
        project.editing.modify(() => migrateZeitgeistDeviceBox(project.boxGraph, zeitgeist, global, false), false)
        expect(zeitgeist.groove.targetAddress.isEmpty()).toBe(true)
        migrateZeitgeistDeviceBox(project.boxGraph, zeitgeist, global, true)
        expect(zeitgeist.groove.targetVertex.unwrap().box).toBe(global)
    })
})
