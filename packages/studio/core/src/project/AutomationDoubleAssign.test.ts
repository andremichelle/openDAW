import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "./ProjectEnv"

// jsdom lacks the Web Audio worklet globals that EngineWorklet extends at module-eval time, so a
// static import of Project would throw on load. Stub it, then import Project dynamically below.
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

// #915: a parameter field may have at most one automation (Value) track; the field adapter asserts
// `Already assigned` when a second TrackBox.target edge reaches it. Pointer updates (and thus the
// assert) are deferred to endTransaction, so the "Create Automation" context menu, which decided at
// build time, could create a second track on a stale click and panic at commit. The fix re-checks
// the authoritative `parameter.track` (the field adapter's `#trackBoxAdapter`, the exact state the
// assert guards) at execution time; for the menu (each click is its own transaction) this reflects
// the prior-committed track.
describe("Automation track double-assignment (#915)", () => {
    it("panics 'Already assigned' when a stale create adds a second automation track for one field", async () => {
        const {Project} = await import("./Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const tracks = project.primaryAudioUnitBoxAdapter.tracks // forces volume field adapter subscription
        const field = project.primaryAudioUnitBox.volume
        const parameter = project.parameterFieldAdapters.get(field.address)
        project.editing.modify(() => tracks.create(TrackType.Value, field)) // commits the first track
        expect(parameter.track.nonEmpty()).toBe(true)
        expect(() => {
            project.boxGraph.beginTransaction()
            tracks.create(TrackType.Value, field)
            project.boxGraph.endTransaction() // assert fires here, at deferred dispatch
        }).toThrow(/Already assigned/)
    })

    it("guarding on parameter.track prevents the second track (the fix)", async () => {
        const {Project} = await import("./Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const tracks = project.primaryAudioUnitBoxAdapter.tracks
        const field = project.primaryAudioUnitBox.volume
        const parameter = project.parameterFieldAdapters.get(field.address)
        const createGuarded = () => project.editing.modify(() => {
            if (parameter.track.nonEmpty()) {return}
            tracks.create(TrackType.Value, field)
        })
        createGuarded()
        expect(createGuarded).not.toThrow()
        expect(tracks.values().filter(track => track.type === TrackType.Value).length).toBe(1)
        project.terminate()
    })

    // Symmetric stale-menu race on "Remove Automation": the menu captured the track adapter at build
    // time; if the track is removed meanwhile, deleting the captured (now-detached) adapter panics
    // `Cannot delete ... Does not exist` (AudioUnitTracks.delete: indexOf === -1).
    it("panics 'Does not exist' when a stale Remove deletes an already-removed track", async () => {
        const {Project} = await import("./Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const tracks = project.primaryAudioUnitBoxAdapter.tracks
        const field = project.primaryAudioUnitBox.volume
        const parameter = project.parameterFieldAdapters.get(field.address)
        project.editing.modify(() => tracks.create(TrackType.Value, field))
        const staleAdapter = parameter.track.unwrap() // captured when the menu was built
        project.editing.modify(() => tracks.delete(staleAdapter)) // track removed by another path
        expect(() => project.editing.modify(() => tracks.delete(staleAdapter))).toThrow(/does not exist/i)
    })

    it("re-reading parameter.track on Remove makes it idempotent (the fix)", async () => {
        const {Project} = await import("./Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const tracks = project.primaryAudioUnitBoxAdapter.tracks
        const field = project.primaryAudioUnitBox.volume
        const parameter = project.parameterFieldAdapters.get(field.address)
        project.editing.modify(() => tracks.create(TrackType.Value, field))
        const removeGuarded = () => project.editing.modify(() => parameter.track.ifSome(track => tracks.delete(track)))
        removeGuarded()
        expect(removeGuarded).not.toThrow() // second click finds no track, no-ops
        expect(tracks.values().filter(track => track.type === TrackType.Value).length).toBe(0)
        project.terminate()
    })
})
