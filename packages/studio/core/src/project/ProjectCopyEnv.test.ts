import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "./ProjectEnv"

// Reproduces live error 1141 (SampleService not set). StudioService is the ProjectEnv and exposes sampleService and
// soundfontService as prototype getters. Project.copy merged the env with an object spread, which only copies own
// properties, so every copied project (Save As, templates, Nextcloud copy, live rooms) lost both services. The next
// audio recording then panicked on stop and the take was never imported.

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

const sampleService = {name: "sample-service"}
const soundfontService = {name: "soundfont-service"}

// Mirrors StudioService: managers are own fields, services are getters on the prototype.
class GetterEnv {
    readonly audioContext = undefined
    readonly audioWorklets = undefined
    readonly sampleManager = createSampleManager()
    readonly soundfontManager = undefined
    get sampleService() {return sampleService}
    get soundfontService() {return soundfontService}
}

const createEnv = (): ProjectEnv => new GetterEnv() as unknown as ProjectEnv

describe("Project.copy keeps the whole env (live error 1141)", () => {
    it("copy() keeps services that are prototype getters", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const copy = project.copy()
        expect(copy.env.sampleService).toBe(sampleService)
        expect(copy.env.soundfontService).toBe(soundfontService)
        expect(copy.env.sampleManager).toBe(project.env.sampleManager)
        copy.terminate()
        project.terminate()
    })
    it("copyWithNewIdentities() keeps services that are prototype getters", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const copy = project.copyWithNewIdentities()
        expect(copy.env.sampleService).toBe(sampleService)
        expect(copy.env.soundfontService).toBe(soundfontService)
        copy.terminate()
        project.terminate()
    })
    it("a copy of a copy still has the services", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const first = project.copy()
        const second = first.copy()
        expect(second.env.sampleService).toBe(sampleService)
        expect(second.env.soundfontService).toBe(soundfontService)
        second.terminate()
        first.terminate()
        project.terminate()
    })
    it("an override replaces only the named member", async () => {
        const {Project} = await import("./Project")
        const project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        const otherSampleManager = createSampleManager()
        const copy = project.copy({sampleManager: otherSampleManager} as unknown as Partial<ProjectEnv>)
        expect(copy.env.sampleManager).toBe(otherSampleManager)
        expect(copy.env.sampleService).toBe(sampleService)
        expect(copy.env.soundfontService).toBe(soundfontService)
        copy.terminate()
        project.terminate()
    })
})
