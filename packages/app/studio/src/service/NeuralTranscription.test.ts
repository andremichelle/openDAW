import {afterEach, describe, expect, it, vi} from "vitest"
import type {Project} from "@opendaw/studio-core"
import type {StudioService} from "./StudioService"
import type {TranscriptionSource} from "./InstrumentTranscription"

const mocks = vi.hoisted(() => ({loaded: vi.fn(), browse: vi.fn(), run: vi.fn()}))
vi.mock("@/service/MuScriptorTranscription", () => {
    mocks.loaded()
    return {MuScriptorTranscription: mocks}
})
afterEach(() => {vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks()})

describe("optional MuScriptor feature", () => {
    it("does not load or call model code when the flag is absent", async () => {
        vi.stubEnv("VITE_ENABLE_MUSCRIPTOR", undefined)
        const {MUSCRIPTOR_ENABLED, NeuralTranscription} = await import("./NeuralTranscription")
        expect(MUSCRIPTOR_ENABLED).toBe(false)
        await NeuralTranscription.browse({} as StudioService)
        await NeuralTranscription.run({} as Project, {} as TranscriptionSource)
        expect(mocks.loaded).not.toHaveBeenCalled()
        expect(mocks.browse).not.toHaveBeenCalled()
        expect(mocks.run).not.toHaveBeenCalled()
    })
    it("lazily loads the feature only after explicit build opt-in and use", async () => {
        vi.stubEnv("VITE_ENABLE_MUSCRIPTOR", "true")
        const {MUSCRIPTOR_ENABLED, NeuralTranscription} = await import("./NeuralTranscription")
        expect(MUSCRIPTOR_ENABLED).toBe(true)
        expect(mocks.loaded).not.toHaveBeenCalled()
        const service = {} as StudioService
        await NeuralTranscription.browse(service)
        expect(mocks.browse).toHaveBeenCalledWith(service)
    })
})
