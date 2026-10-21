// @vitest-environment jsdom
import {beforeEach, describe, expect, it, vi} from "vitest"
import type {Project} from "@opendaw/studio-core"
import type {StudioService} from "./StudioService"
import type {TranscriptionSource} from "./InstrumentTranscription"

const mocks = vi.hoisted(() => {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
    return {show: vi.fn(), convert: vi.fn(), requiredDownloadBytes: vi.fn(), run: vi.fn()}
})
vi.mock("@/ui/components/dialogs", () => ({Dialogs: {show: mocks.show}}))
vi.mock("./InferenceLoader", () => ({ensureInference: async () => {}}))
vi.mock("@opendaw/studio-core", () => ({AudioContentFactory: {}}))
// Inspect dialog content without loading the JSX library's browser stylesheet side effects.
vi.mock("@opendaw/lib-jsx", () => ({createElement: (tag: string, props: unknown, ...children: unknown[]) => ({tag, props, children})}))
vi.mock("./InstrumentTranscription", () => ({InstrumentTranscription: {isRunning: () => false, convert: mocks.convert}}))
vi.mock("@opendaw/lib-inference/muscriptor", () => ({MuScriptor: {
    downloadBytes: 616274526, checkSupport: async () => {}, requiredDownloadBytes: mocks.requiredDownloadBytes, run: mocks.run
}}))
import {MuScriptorTranscription} from "./MuScriptorTranscription"

beforeEach(() => {
    vi.clearAllMocks()
    mocks.requiredDownloadBytes.mockResolvedValue(616274526)
    mocks.show.mockResolvedValue(undefined)
    mocks.run.mockResolvedValue([])
    mocks.convert.mockImplementation(async (_project, _source, analyze) => {
        await analyze({frames: [new Float32Array(16000)], sampleRate: 16000}, {start: 0, end: 1},
            {signal: new AbortController().signal, progress() {}, message() {}})
    })
})

describe("first-download consent", () => {
    it("cancel or dismissal leaves file import and project state untouched", async () => {
        mocks.show.mockRejectedValue(new DOMException("Cancelled", "AbortError"))
        const newProject = vi.fn(), importFile = vi.fn()
        const service = {hasProfile: false, newProject, sampleService: {importFile}} as unknown as StudioService
        await MuScriptorTranscription.importFile(service, new File(["audio"], "example.wav"))
        expect(newProject).not.toHaveBeenCalled()
        expect(importFile).not.toHaveBeenCalled()
        expect(mocks.convert).not.toHaveBeenCalled()
        expect(mocks.run).not.toHaveBeenCalled()
    })
    it("shows the missing MB and explicit choices before permitting downloads", async () => {
        mocks.requiredDownloadBytes.mockResolvedValue(6221824)
        await MuScriptorTranscription.run({} as Project, {} as TranscriptionSource)
        const prompt = mocks.show.mock.calls[0][0]
        expect(JSON.stringify(prompt.content)).toContain("Download required: ")
        expect(JSON.stringify(prompt.content)).toContain("6.2")
        expect(JSON.stringify(prompt.content)).toContain("616.3")
        expect(prompt.okText).toBe("Download & Continue")
        expect(prompt.buttons[0].text).toBe("Cancel")
        expect(mocks.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({allowDownload: true}))
    })
    it("reuses a complete cache without prompting or allowing a fallback download", async () => {
        mocks.requiredDownloadBytes.mockResolvedValue(0)
        await MuScriptorTranscription.run({} as Project, {} as TranscriptionSource)
        await MuScriptorTranscription.run({} as Project, {} as TranscriptionSource)
        expect(mocks.show).not.toHaveBeenCalled()
        expect(mocks.run).toHaveBeenCalledTimes(2)
        expect(mocks.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({allowDownload: false}))
    })
})
