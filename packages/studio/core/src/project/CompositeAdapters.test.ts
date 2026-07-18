import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    DeviceHost,
    Devices,
    AudioEffectCompositeBoxAdapter,
    StereoCompositeBoxAdapter,
    AudioEffectCompositeCellBoxAdapter,
    InstrumentFactories,
    ProjectSkeleton
} from "@opendaw/studio-adapters"
import {
    CrusherDeviceBox,
    AudioEffectCompositeBox,
    AudioEffectCompositeCellBox,
    PitchDeviceBox,
    StereoCompositeBox,
    StereoToolDeviceBox
} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./ProjectEnv"

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
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

// A composite ENTRY is a ONE-SIDED DeviceHost: it hosts exactly one chain kind and no instrument. That is what
// lets the device panel be entered on it (like a Playfield slot), while making it impossible to insert an effect
// of the kind it cannot host.
describe("Composite adapters", () => {
    it("an audio entry hosts an audio chain only, and routes back to its unit", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {composite, entryA, entryB, nested} = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const composite = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
            const entryA = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
                box.label.setValue("A")
            })
            const entryB = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(1)
                box.label.setValue("B")
            })
            const nested = StereoToolDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(entryA.audioEffects)
                box.index.setValue(0)
            })
            return {composite, entryA, entryB, nested}
        }).unwrap()
        const compositeAdapter = project.boxAdapters.adapterFor(composite, AudioEffectCompositeBoxAdapter)
        expect(compositeAdapter.entries.adapters().map(entry => entry.label)).toStrictEqual(["A", "B"])
        expect(compositeAdapter.entriesFixed, "a user-built stack manages its own entries").toBe(false)
        const entryAdapter = project.boxAdapters.adapterFor(entryA, AudioEffectCompositeCellBoxAdapter)
        // One-sided: an audio chain (holding the nested effect), and NO midi chain at all.
        expect(entryAdapter.audioEffects.unwrap("audioEffects").adapters().map(effect => effect.uuid))
            .toStrictEqual([nested.address.uuid])
        expect(entryAdapter.midiEffects.isEmpty(), "an audio entry hosts no midi chain").toBe(true)
        expect(entryAdapter.midiEffectsField.isEmpty()).toBe(true)
        expect(DeviceHost.takesEffect(entryAdapter, "audio")).toBe(true)
        expect(DeviceHost.takesEffect(entryAdapter, "midi"), "no midi chain to insert into").toBe(false)
        // It hosts no instrument, and leads back to the unit the composite lives in.
        expect(entryAdapter.hostsInstrument).toBe(false)
        expect(entryAdapter.inputAdapter.isEmpty()).toBe(true)
        expect(entryAdapter.isAudioUnit).toBe(false)
        expect(entryAdapter.deviceHost().address).toStrictEqual(compositeAdapter.deviceHost().address)
        expect(entryAdapter.audioUnitBoxAdapter().address)
            .toStrictEqual(compositeAdapter.audioUnitBoxAdapter().address)
        // The nested effect resolves its host to the ENTRY, not to the unit.
        const nestedAdapter = project.boxAdapters.adapterFor(nested, Devices.isEffect)
        expect(nestedAdapter.deviceHost().address).toStrictEqual(entryAdapter.address)
        expect(project.boxAdapters.adapterFor(entryB, AudioEffectCompositeCellBoxAdapter)
            .audioEffects.unwrap("audioEffects").isEmpty(), "an empty entry is an identity branch").toBe(true)
        project.terminate()
    })

    it("toggling an entry's mute through its parameter adapter writes the box field", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {entryA} = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const composite = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
            const entryA = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })
            return {entryA}
        }).unwrap()
        const entryAdapter = project.boxAdapters.adapterFor(entryA, AudioEffectCompositeCellBoxAdapter)
        expect(entryA.mute.getValue()).toBe(false)
        project.editing.modify(() => entryAdapter.namedParameter.mute.setValue(true))
        expect(entryA.mute.getValue(), "the adapter write reached the box field").toBe(true)
        project.editing.modify(() => entryAdapter.namedParameter.pan.setValue(-1.0))
        expect(entryA.pan.getValue(), "pan write reached the box field").toBe(-1.0)
        project.terminate()
    })

    it("an audio unit still hosts both chains, and gates midi on its instrument", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const unit = project.editing.modify(() =>
            project.api.createAnyInstrument(InstrumentFactories.Vaporisateur).audioUnitBox).unwrap()
        const host = project.boxAdapters.adapterFor(unit, Devices.isHost)
        expect(host.midiEffects.nonEmpty()).toBe(true)
        expect(host.audioEffects.nonEmpty()).toBe(true)
        expect(host.hostsInstrument).toBe(true)
        // Vaporisateur consumes notes, so the unit takes midi effects.
        expect(DeviceHost.takesEffect(host, "midi")).toBe(true)
        expect(DeviceHost.takesEffect(host, "audio")).toBe(true)
        project.terminate()
    })

    it("a Crusher dropped in an entry reports that entry as its host", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {entry, crusher} = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const composite = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
            const entry = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })
            const crusher = CrusherDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(entry.audioEffects)
                box.index.setValue(0)
            })
            return {entry, crusher}
        }).unwrap()
        const entryAdapter = project.boxAdapters.adapterFor(entry, AudioEffectCompositeCellBoxAdapter)
        const crusherAdapter = project.boxAdapters.adapterFor(crusher, Devices.isEffect)
        // Devices.deleteEffectDevices resolves the chain field through the host: it must find the ENTRY's chain.
        expect(DeviceHost.chainFieldOf(crusherAdapter.deviceHost(), "audio").unwrap("audio chain").address)
            .toStrictEqual(entry.audioEffects.address)
        expect(entryAdapter.audioEffects.unwrap("audioEffects").adapters().length).toBe(1)
        project.editing.modify(() => Devices.deleteEffectDevices([crusherAdapter]))
        expect(entryAdapter.audioEffects.unwrap("audioEffects").isEmpty(), "delete removes it from the entry")
            .toBe(true)
        project.terminate()
    })
})

// The stereo split is the first SPLIT container: unlike the user-built stack its entries are created by the
// factory and fixed, because the engine's distributor maps them BY INDEX (0 = left, 1 = right).
describe("Stereo split factory", () => {
    it("creates exactly two fixed entries, L then R, in the order the distributor maps", async () => {
        const {Project} = await import("./Project")
        const {EffectFactories} = await import("../EffectFactories")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const box = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            return EffectFactories.StereoComposite.create(project, product.audioUnitBox.audioEffects, 0)
        }).unwrap()
        const adapter = project.boxAdapters.adapterFor(box as StereoCompositeBox, StereoCompositeBoxAdapter)
        expect(adapter.entriesFixed, "a split owns its entries; the UI offers no add / remove").toBe(true)
        const entries = adapter.entries.adapters()
        expect(entries.map(entry => entry.label)).toStrictEqual(["L", "R"])
        expect(entries.map(entry => entry.indexField.getValue()), "index 0 is the LEFT branch, 1 the right")
            .toStrictEqual([0, 1])
        // Both start empty: two untouched branches sum back to the input, so a fresh split is a bypass.
        for (const entry of entries) {
            expect(entry.audioEffects.unwrap("audioEffects").isEmpty()).toBe(true)
        }
        project.terminate()
    })
})

// "Add Entry" creates a cell box; the editor's list only shows it because the entries collection NOTIFIES.
// The list rebuilds its rows from a Provider on every add / remove / reorder — a snapshot taken once at mount
// left the button looking dead (the box appeared in the graph, never on screen).
describe("Composite entry collection is observable", () => {
    it("notifies on add, remove and reorder so the entry list can rebuild", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const composite = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            return AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
        }).unwrap()
        const adapter = project.boxAdapters.adapterFor(composite, AudioEffectCompositeBoxAdapter)
        let notifications = 0
        const subscription = adapter.entries.subscribe({
            onAdd: () => {notifications++},
            onRemove: () => {notifications++},
            onReorder: () => {notifications++}
        })
        expect(adapter.entries.adapters().length).toBe(0)
        // What the "+ Add Entry" button does.
        const entry = project.editing.modify(() =>
            AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })).unwrap()
        expect(notifications, "the list is told to rebuild").toBe(1)
        expect(adapter.entries.adapters().length, "and the entry is there to render").toBe(1)
        project.editing.modify(() => entry.delete())
        expect(notifications, "removal notifies too").toBe(2)
        expect(adapter.entries.adapters().length).toBe(0)
        subscription.terminate()
        project.terminate()
    })
})

// Deleting an entry is what the row's delete button does: the cell goes, its whole chain goes with it (the
// effects' `host` is mandatory, so `delete()` cascades), and the SURVIVORS reindex to stay 0..n-1 — the
// engine reads that index as the entry's order, so a hole would misorder the stack (and mis-map a split).
describe("Deleting a composite entry", () => {
    it("takes the entry's chain with it and reindexes the survivors", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {composite, entryA, nestedInA} = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const composite = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
            const make = (index: number, label: string) =>
                AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                    box.composite.refer(composite.entries)
                    box.index.setValue(index)
                    box.label.setValue(label)
                })
            const entryA = make(0, "A")
            make(1, "B")
            make(2, "C")
            const nestedInA = StereoToolDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(entryA.audioEffects)
                box.index.setValue(0)
            })
            return {composite, entryA, nestedInA}
        }).unwrap()
        const adapter = project.boxAdapters.adapterFor(composite, AudioEffectCompositeBoxAdapter)
        expect(adapter.entries.adapters().map(entry => entry.label)).toStrictEqual(["A", "B", "C"])
        expect(nestedInA.isAttached(), "A holds an effect").toBe(true)
        // Exactly what the delete button runs: capture the survivors first, delete, then reindex.
        const survivors = adapter.entries.adapters().filter(other => other.box !== entryA)
        project.editing.modify(() => {
            entryA.box.delete()
            survivors.forEach((other, index) => other.indexField.setValue(index))
        })
        expect(adapter.entries.adapters().map(entry => entry.label), "A is gone").toStrictEqual(["B", "C"])
        expect(adapter.entries.adapters().map(entry => entry.indexField.getValue()),
            "and the survivors closed the hole").toStrictEqual([0, 1])
        expect(nestedInA.isAttached(), "A's chain went with it — no dangling effect").toBe(false)
        project.terminate()
    })
})

// REPRO for the delete crash: the device editor rebuilds its row list on every entries notification, and each
// row resolves `compositeDevice()` / `audioUnitBoxAdapter()`. If a notification fires while an entry's mandatory
// `composite` pointer is transiently detached, that resolve panics ("composite.target").
describe("Deleting an entry while the list re-renders", () => {
    it("does not resolve a detached entry during the delete transaction", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {composite, entryA} = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const composite = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
            const make = (index: number, label: string) =>
                AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                    box.composite.refer(composite.entries)
                    box.index.setValue(index)
                    box.label.setValue(label)
                })
            const entryA = make(0, "A")
            make(1, "B")
            make(2, "C")
            StereoToolDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(entryA.audioEffects)
                box.index.setValue(0)
            })
            return {composite, entryA}
        }).unwrap()
        const adapter = project.boxAdapters.adapterFor(composite, AudioEffectCompositeBoxAdapter)
        // What AudioCompositeEntry does at construction, for every row, on every rebuild: resolve the mandatory
        // `composite` pointer. A notification for a half-deleted entry used to render it here and panic.
        const render = () => adapter.entries.adapters().forEach(entry => {
            entry.compositeDevice()
            entry.audioUnitBoxAdapter()
        })
        const subscription = adapter.entries.subscribe({onAdd: render, onRemove: render, onReorder: render})
        const survivors = adapter.entries.adapters().filter(other => other.box !== entryA)
        expect(() => project.editing.modify(() => {
            entryA.box.delete()
            survivors.forEach((other, index) => other.indexField.setValue(index))
        }), "the delete button must not crash the reactive list").not.toThrow()
        expect(adapter.entries.adapters().map(entry => entry.label)).toStrictEqual(["B", "C"])
        subscription.terminate()
        project.terminate()
    })
})

// The composite INPUT tap is scoped: only a device INSIDE the composite may pick it as a sidechain source
// (SidechainButton walks the host chain via `compositeDevice()`). A device outside sees no composite ancestor.
describe("Composite input-tap scoping", () => {
    it("a device inside a composite reaches the composite input; a device outside does not", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {composite, inside, outside} = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const composite = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
            const entry = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })
            // A compressor INSIDE the composite (in the entry's chain), and one OUTSIDE (on the unit chain).
            const inside = CrusherDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(entry.audioEffects)
                box.index.setValue(0)
            })
            const outside = CrusherDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(1)
            })
            return {composite, inside, outside}
        }).unwrap()
        // Mirror SidechainButton's walk: follow the device's host chain collecting enclosing composites.
        const enclosing = (deviceBox: CrusherDeviceBox) => {
            const result: Array<string> = []
            let host = project.boxAdapters.adapterFor(deviceBox, Devices.isEffect).deviceHost()
            while (host instanceof AudioEffectCompositeCellBoxAdapter) {
                const c = host.compositeDevice()
                result.push(UUID.toString(c.uuid))
                host = c.deviceHost()
            }
            return result
        }
        expect(enclosing(inside), "the device inside sees the composite's input")
            .toStrictEqual([UUID.toString(composite.address.uuid)])
        expect(enclosing(outside), "the device outside sees no composite ancestor").toStrictEqual([])
        project.terminate()
    })
})

// The "back" button in an entered entry returns to the entry's IMMEDIATE parent — the audio unit for a
// top-level entry, or the OUTER entry when composites are nested (it must not jump straight to the unit,
// skipping intermediate composites). CompositeCellEditor navigates to `host.deviceHost().box`.

describe("Composite entry back-navigation", () => {
    // Mirror CompositeCellEditor.backTarget: a composite CELL accepts the Editing pointer at the box level; an
    // AUDIO UNIT accepts it only through its `editing` field. Pointing the editing pointer at the wrong vertex
    // throws at runtime ("does not satisfy any of the allowed types"), so this exercises edit() end to end.
    it("BACK edits the parent host without a pointer-type error, resolving to the right chain", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {unit, outerEntry, innerEntry} = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const outer = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
            const outerEntry = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(outer.entries)
                box.index.setValue(0)
            })
            const inner = AudioEffectCompositeBox.create(project.boxGraph, UUID.generate(), box => {
                box.host.refer(outerEntry.audioEffects)
                box.index.setValue(0)
            })
            const innerEntry = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(inner.entries)
                box.index.setValue(0)
            })
            return {unit: product.audioUnitBox, outerEntry, innerEntry}
        }).unwrap()
        const {userEditingManager} = project
        // Exactly CompositeCellEditor.backTarget.
        const backTargetOf = (entryBox: AudioEffectCompositeCellBox) => {
            const parent = project.boxAdapters.adapterFor(entryBox, AudioEffectCompositeCellBoxAdapter).deviceHost()
            return parent instanceof AudioEffectCompositeCellBoxAdapter
                ? parent.box
                : parent.audioUnitBoxAdapter().box.editing
        }
        // Top-level entry -> the audio unit (via its editing FIELD). Must not throw.
        userEditingManager.audioUnit.edit(backTargetOf(outerEntry))
        expect(userEditingManager.audioUnit.get().unwrap().box.address, "top-level backs out to the unit")
            .toStrictEqual(unit.address)
        // Nested entry -> the OUTER entry box directly. Must not throw, and NOT jump to the unit.
        userEditingManager.audioUnit.edit(backTargetOf(innerEntry))
        expect(userEditingManager.audioUnit.get().unwrap().box.address, "nested backs out to its parent entry")
            .toStrictEqual(outerEntry.address)
        project.terminate()
    })
})
