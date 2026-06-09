import {describe, expect, it} from "vitest"
import {asDefined, isDefined, Option, Optional, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, AudioUnitFactory, Devices, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import type {ProjectEnv} from "./ProjectEnv"

// Repro for "Mixer has no channel-strip state for audio-unit … (type=…, attached=true) … absent from
// rootBox.audioUnits" (#924/925/926/984/985 and #1005-1007), via the live DevicePanel registration path.
//
// The core Mixer's #states is populated only from rootBox.audioUnits, and pointer-edge notifications are
// dispatched at endTransaction (Graph.#finalizeTransaction). So inside a transaction a freshly created unit
// is already connected to rootBox.audioUnits but the Mixer's #states has NOT caught up. DevicePanel.tsx:136
// resolves the unit via `deviceHost.audioUnitBoxAdapter()` — independent of the collection — and registers a
// ChannelStrip for it. If that render runs inside the transaction window, registerChannelStrip finds no state
// and panics. No recovery and no corrupt persisted graph required: it is purely a registration/timing gap.

// jsdom lacks the Web Audio worklet globals EngineWorklet extends at module-eval time, so a static import of
// Project would throw on load. Stub it, then import Project dynamically below.
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
    record: () => {},
    invalidate: () => {},
    remove: () => {},
    register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined,
    audioWorklets: undefined,
    sampleManager: createSampleManager(),
    soundfontManager: undefined,
    sampleService: undefined,
    soundfontService: undefined
}) as unknown as ProjectEnv

describe("Mixer channel-strip registration vs rootBox.audioUnits", () => {
    it("registering via the DevicePanel adapter path panics while #states lags rootBox.audioUnits, then succeeds once it catches up", async () => {
        const {Project} = await import("./Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const {boxGraph} = project
        const view = {silent: () => {}}

        let adapter: Optional<AudioUnitBoxAdapter> = undefined
        let insideStatus = "none"
        let insideError = ""
        project.editing.modify(() => {
            const capture = AudioUnitFactory.trackTypeToCapture(boxGraph, TrackType.Notes)
            const unit = AudioUnitFactory.create(project.skeleton, AudioUnitType.Instrument, capture)
            VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
            // The unit IS already a member of rootBox.audioUnits (pointer connected) ...
            const enrolled = project.rootBox.audioUnits.pointerHub.incoming().some(pointer => pointer.box === unit)
            expect(enrolled).toBe(true)
            // ... but onAdd (which fills the Mixer's #states) only fires at endTransaction, so #states lags.
            // DevicePanel resolves the unit via the device chain, independent of the collection:
            adapter = project.boxAdapters.adapterFor(unit.input.pointerHub.incoming()[0].box, Devices.isInstrument)
                .audioUnitBoxAdapter()
            const attempt = tryCatch(() => project.mixer.registerChannelStrip(asDefined(adapter), view))
            insideStatus = attempt.status
            if (attempt.status === "failure") {insideError = String(attempt.error)}
        })

        // Same unit, same adapter, after endTransaction: #states has now caught up, so it registers cleanly.
        const afterTransaction = tryCatch(() => project.mixer.registerChannelStrip(asDefined(adapter), view))

        expect(insideStatus).toBe("failure") // <-- reproduces the #1005-1007 panic
        expect(insideError).toContain("Mixer has no channel-strip state")
        expect(afterTransaction.status).toBe("success")
        if (afterTransaction.status === "success") {afterTransaction.value.terminate()}
        project.terminate()
    })
})
