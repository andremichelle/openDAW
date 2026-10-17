import {describe, expect, it} from "vitest"
import {Arrays, Option, Terminable, UUID} from "@opendaw/lib-std"
import {applyUpdateTasks, BoxGraph, Update, UpdateTask} from "@opendaw/lib-box"
import {BoxIO, NativeInstrumentBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, InstrumentFactory, ProjectSkeleton, TrackType, WclapParamInfo} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import type {ProjectEnv} from "../project/ProjectEnv"
import {WclapParameters} from "./WclapParameters"

// The steps of 2026-10-17 (Serum 2, then the openDAW Test Synth, plans/native-plugins.md gap 14) with Vaporisateur and
// with a native plugin instrument: create it, record (a gesture sealed at its end), delete something, then undo all
// the way back and redo. NativePluginHost keeps a new device's undo step open until the plugin reported its
// parameters, their boxes join that step. Parameter boxes created outside the history (reported later) still make the
// undo of the creation fail and leave the source graph without the instrument while the engine keeps it.

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const param = (id: number): WclapParamInfo =>
    ({id, name: `P${id}`, module: "", min: 0, max: 1, defaultValue: 0, value: 0, flags: 0})

// the engine's mirror, fed like SyncSource feeds it: every transaction that was not rolled back
const mirrorOf = (source: BoxGraph<BoxIO.TypeMap>): BoxGraph<BoxIO.TypeMap> => {
    const mirror = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    const tasks: Array<UpdateTask<BoxIO.TypeMap>> = []
    mirror.beginTransaction()
    applyUpdateTasks(mirror, source.boxes().map(box =>
        ({type: "new", name: box.name as keyof BoxIO.TypeMap, uuid: box.address.uuid, buffer: box.toArrayBuffer()})))
    mirror.endTransaction()
    source.subscribeTransaction({
        onBeginTransaction: () => {},
        onEndTransaction: (rolledBack: boolean) => {
            if (!rolledBack) {
                mirror.beginTransaction()
                applyUpdateTasks(mirror, tasks)
                mirror.endTransaction()
            }
            tasks.length = 0
        }
    })
    source.subscribeToAllUpdatesImmediate({
        onUpdate: (update: Update) => {
            if (update.type === "new") {
                tasks.push({type: "new", name: update.name as keyof BoxIO.TypeMap, uuid: update.uuid, buffer: update.settings})
            } else if (update.type === "primitive") {
                tasks.push({type: "update-primitive", address: update.address.decompose(),
                    primitiveType: update.serialization.type, value: update.newValue})
            } else if (update.type === "pointer") {
                tasks.push({type: "update-pointer", address: update.address.decompose(),
                    target: update.newAddress.unwrapOrNull()?.decompose()})
            } else if (update.type === "delete") {
                tasks.push({type: "delete", uuid: update.uuid})
            }
        }
    })
    return mirror
}

// as NativePluginHost creates it
const nativeFactory: InstrumentFactory<void, NativeInstrumentBox> = {
    defaultName: "openDAW Test Synth", defaultIcon: IconSymbol.Piano, briefDescription: "Plugin", description: "", manualPage: "",
    trackType: TrackType.Notes,
    create: (boxGraph, host, name, icon) => NativeInstrumentBox.create(boxGraph, UUID.generate(), box => {
        box.label.setValue(name)
        box.icon.setValue(IconSymbol.toName(icon))
        box.format.setValue("vst3")
        box.pluginId.setValue("6F70656E44415754657374536E746800")
        box.pluginName.setValue(name)
        box.host.refer(host)
    })
}

// the parameters the openDAW Test Synth reports
const testSynthParams = ["Level", "Tone", "Follow", "Mode"].map((name, id): WclapParamInfo =>
    ({id, name, module: "", min: 0, max: 1, defaultValue: 0.5, value: 0.5, flags: 0}))

type Params = "none" | "with-the-device" | "outside-history"

const run = async (factory: InstrumentFactory<any, any>, params: Params) => {
    const {Project} = await import("../project/Project")
    const project = Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    const {editing, timelineBox} = project
    const mirror = mirrorOf(project.boxGraph)
    const inSync = () => Arrays.equals(mirror.checksum(), project.boxGraph.checksum())
    const {instrumentBox} = editing.modify(() => project.api.createAnyInstrument(factory), params !== "with-the-device").unwrap()
    // the plugin loaded and sent its "params" notice
    const reconcile = () => WclapParameters.reconcileHub(project, (instrumentBox as NativeInstrumentBox).parameters, testSynthParams)
    if (params === "with-the-device") {
        editing.modify(reconcile, false)
        editing.mark()
    } else if (params === "outside-history") {
        reconcile()
    }
    // recording: unmarked changes, sealed at the end of the gesture
    editing.modify(() => timelineBox.bpm.setValue(140), false)
    editing.mark()
    // the delete
    editing.modify(() => timelineBox.signature.nominator.setValue(3))
    const undos = [editing.undo(), editing.undo(), editing.undo()]
    const afterUndo = {attached: instrumentBox.isAttached(), inSync: inSync()}
    const redos = [editing.redo(), editing.redo(), editing.redo()]
    return {undos, afterUndo, redos, inSyncAfterRedo: inSync()}
}

describe("undo all the way back past an instrument's creation, then redo", () => {
    it("Vaporisateur", async () => {
        const result = await run(InstrumentFactories.Vaporisateur, "none")
        expect(result.undos).toEqual([true, true, true])
        expect(result.afterUndo).toEqual({attached: false, inSync: true})
        expect(result.redos).toEqual([true, true, true])
        expect(result.inSyncAfterRedo).toBe(true)
    })

    it("a native plugin instrument (the openDAW Test Synth), its parameters in the device's step", async () => {
        const result = await run(nativeFactory, "with-the-device")
        expect(result.undos).toEqual([true, true, true])
        expect(result.afterUndo).toEqual({attached: false, inSync: true})
        expect(result.redos).toEqual([true, true, true])
        expect(result.inSyncAfterRedo).toBe(true)
    })

    it("a native plugin instrument whose parameters came outside the history: the third undo fails, the engine diverges", async () => {
        const result = await run(nativeFactory, "outside-history")
        expect(result.undos).toEqual([true, true, false])
        expect(result.afterUndo).toEqual({attached: false, inSync: false})
    })
})
