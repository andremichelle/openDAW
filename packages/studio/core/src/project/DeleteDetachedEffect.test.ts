import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {Devices, EffectDeviceBoxAdapter, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {CompressorDeviceBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./ProjectEnv"

// Reproduces live error 1039 (no device-host). The effect context-menu "Delete" (menu-items.ts
// populateMenuItemToDeleteDevice) captures the EffectDeviceBoxAdapter when the floating menu opens, then runs
// Devices.deleteEffectDevices([device]) on the captured adapter when the item is triggered. The menu is a
// Surface-layer element, not owned by the device editor's lifecycle, so it survives after the effect box is
// detached. If the trigger fires against an already-detached device — a double-fire of pointerup (the reports
// are on touch devices: Android Fire, CrOS) or a deletion that happened while the menu stayed open — then
// device.deviceHost() unwraps an empty host pointer and panics with "no device-host".

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

describe("Deleting an already-detached effect (live error 1039)", () => {
    it("deleteEffectDevices panics with 'no device-host' when fired on a detached adapter", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const {effect} = project.editing.modify(() => {
            const product = project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
            const effect = CompressorDeviceBox.create(project.boxGraph, UUID.generate(), box => {
                box.label.setValue("Compressor")
                box.host.refer(product.audioUnitBox.audioEffects)
                box.index.setValue(0)
            })
            return {effect}
        }).unwrap()
        const adapter = project.boxAdapters.adapterFor(effect, Devices.isEffect) as EffectDeviceBoxAdapter
        expect(tryCatch(() => adapter.deviceHost()).status, "attached device resolves its host").toBe("success")
        // First trigger: the real Delete. Detaches the effect box.
        project.editing.modify(() => Devices.deleteEffectDevices([adapter]))
        // Second trigger fired on the same captured (now detached) adapter — the 1039 crash.
        const attempt = tryCatch(() => project.editing.modify(() => Devices.deleteEffectDevices([adapter])))
        expect(attempt.status, "stale re-delete must reach the panic").toBe("failure")
        expect(String(attempt.status === "failure" ? attempt.error : "")).toContain("no device-host")
        project.terminate()
    })
})
