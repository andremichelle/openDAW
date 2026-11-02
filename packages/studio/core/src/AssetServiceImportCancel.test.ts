import {beforeEach, describe, expect, it, vi} from "vitest"
import {Errors, isDefined, RuntimeNotification, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Files} from "@opendaw/lib-dom"
import {Wait} from "@opendaw/lib-runtime"
import {AudioUnitBox, SoundfontDeviceBox, SoundfontFileBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton, Soundfont} from "@opendaw/studio-adapters"
import {AssetService} from "./AssetService"
import {FilePickerAcceptTypes} from "./FilePickerAcceptTypes"
import {ExternalLib} from "./ExternalLib"
import {SoundfontStorage} from "./soundfont/SoundfontStorage"
import {SoundfontService} from "./soundfont/SoundfontService"

// Issue 520: declining the large-soundfont prompt still parsed, stored and announced the soundfont.
// A cancelled import must leave no side effects and must not be reported as a failure.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

let approveAnswer = false
const approvals: Array<string> = []
const infos: Array<string> = []
const notifications: Array<string> = []
RuntimeNotifier.install({
    info: async (request: RuntimeNotification.InfoRequest) => {infos.push(request.headline ?? "")},
    approve: async (request: RuntimeNotification.ApproveRequest) => {
        approvals.push(request.headline ?? "")
        return approveAnswer
    },
    progress: () => ({message: "", terminate: () => {}}),
    notify: (request: RuntimeNotification.NotifyRequest) => {notifications.push(request.message)}
})

const saved: Array<string> = []
vi.spyOn(SoundfontStorage, "get").mockReturnValue({
    list: async () => [],
    save: async ({meta}: { meta: { name: string } }) => {saved.push(meta.name)}
} as unknown as SoundfontStorage)
vi.spyOn(Wait, "frame").mockResolvedValue(undefined)
let parsed = 0
class FakeSoundFont2 {
    readonly metaData = {name: "Fake", copyright: undefined}
    constructor() {parsed++}
}
vi.spyOn(ExternalLib, "SoundFont2").mockImplementation(async () =>
    ({status: "resolved", value: FakeSoundFont2}) as unknown as Awaited<ReturnType<typeof ExternalLib.SoundFont2>>)

const Threshold = 1 << 24

const createSoundfontService = async () => {
    const service = new SoundfontService()
    while (service.local.isEmpty()) {await Promise.resolve()}
    return service
}

const reset = () => {
    approvals.length = 0
    infos.length = 0
    notifications.length = 0
    saved.length = 0
    parsed = 0
}

describe("SoundfontService.importFile size prompt (issue 520)", () => {
    beforeEach(reset)

    it("rejects with an abort and has no side effects when the prompt is cancelled", async () => {
        approveAnswer = false
        const service = await createSoundfontService()
        const observed: Array<Soundfont> = []
        service.subscribe(([soundfont]) => observed.push(soundfont))
        const result = service.importFile({arrayBuffer: new ArrayBuffer(Threshold + 1)})
        await expect(result).rejects.toSatisfy(Errors.isAbort)
        expect(approvals).toHaveLength(1)
        expect(parsed).toBe(0)
        expect(saved).toEqual([])
        expect(observed).toEqual([])
        expect(service.local.unwrap()).toEqual([])
    })

    it("imports when the prompt is approved", async () => {
        approveAnswer = true
        const service = await createSoundfontService()
        const observed: Array<Soundfont> = []
        service.subscribe(([soundfont]) => observed.push(soundfont))
        const soundfont = await service.importFile({arrayBuffer: new ArrayBuffer(Threshold + 1)})
        expect(approvals).toHaveLength(1)
        expect(parsed).toBe(1)
        expect(saved).toEqual(["Fake"])
        expect(observed).toEqual([soundfont])
        expect(service.local.unwrap()).toEqual([soundfont])
    })

    it("does not ask for a file at the threshold", async () => {
        approveAnswer = false
        const service = await createSoundfontService()
        await service.importFile({arrayBuffer: new ArrayBuffer(Threshold)})
        expect(approvals).toEqual([])
        expect(saved).toEqual(["Fake"])
    })

    it("does not ask for a small file", async () => {
        approveAnswer = false
        const service = await createSoundfontService()
        await service.importFile({arrayBuffer: new ArrayBuffer(1024)})
        expect(approvals).toEqual([])
        expect(saved).toEqual(["Fake"])
    })
})

class TestSoundfontService extends AssetService<Soundfont, void> {
    protected readonly nameSingular: string = "Soundfont"
    protected readonly namePlural: string = "Soundfonts"
    protected readonly boxType = SoundfontFileBox
    protected readonly filePickerOptions: FilePickerOptions = FilePickerAcceptTypes.SoundfontFiles

    readonly invalidated: Array<string> = []

    constructor(readonly outcome: (name: string) => Promise<Soundfont>) {super()}

    acceptsFile(): boolean {return true}

    async importFile({name}: AssetService.ImportArgs): Promise<Soundfont> {return this.outcome(name ?? "")}

    protected async collectAllFiles(): Promise<ReadonlyArray<Soundfont>> {return []}
}

const fileOf = (name: string): File =>
    ({name, arrayBuffer: async () => new ArrayBuffer(0)}) as unknown as File

const soundfontOf = (name: string): Soundfont =>
    ({uuid: UUID.toString(UUID.generate()), name, size: 0, url: "unknown", license: "", origin: "import"})

describe("AssetService with a cancelled import (issue 520)", () => {
    beforeEach(reset)

    it("importFiles skips a cancelled file silently and imports the rest", async () => {
        const service = new TestSoundfontService(async name =>
            name === "cancelled.sf2" ? Promise.reject(Errors.AbortError) : soundfontOf(name))
        const imported = await service.importFiles([
            fileOf("cancelled.sf2"), fileOf("kept.sf2")])
        expect(imported.map(({name}) => name)).toEqual(["kept.sf2"])
        expect(infos).toEqual([])
    })

    it("importFiles still reports genuine failures next to a cancelled file", async () => {
        const service = new TestSoundfontService(async name =>
            name === "cancelled.sf2" ? Promise.reject(Errors.AbortError) : Promise.reject(new Error("broken")))
        const imported = await service.importFiles([
            fileOf("cancelled.sf2"), fileOf("broken.sf2")])
        expect(imported).toEqual([])
        expect(infos).toEqual(["Soundfont Import Issues"])
    })

    const createGraphWithMissingSoundfont = () => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        boxGraph.beginTransaction()
        const audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const fileBox = SoundfontFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue("missing.sf2"))
        SoundfontDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.file.refer(fileBox)
            box.host.refer(audioUnitBox.input)
        })
        boxGraph.endTransaction()
        return boxGraph
    }

    it("replaceMissingFiles neither reports nor invalidates a cancelled replacement", async () => {
        approveAnswer = true
        const open = vi.spyOn(Files, "open").mockResolvedValue([fileOf("huge.sf2")])
        const service = new TestSoundfontService(() => Promise.reject(Errors.AbortError))
        const invalidated: Array<UUID.Bytes> = []
        await service.replaceMissingFiles(createGraphWithMissingSoundfont(),
            {invalidate: uuid => invalidated.push(uuid)})
        open.mockRestore()
        expect(infos).toEqual([])
        expect(notifications).toEqual([])
        expect(invalidated).toEqual([])
    })

    it("replaceMissingFiles still reports a genuine failure", async () => {
        approveAnswer = true
        const open = vi.spyOn(Files, "open").mockResolvedValue([fileOf("broken.sf2")])
        const service = new TestSoundfontService(() => Promise.reject(new Error("broken")))
        await service.replaceMissingFiles(createGraphWithMissingSoundfont(), {invalidate: () => {}})
        open.mockRestore()
        expect(infos).toEqual(["Soundfont Import Failed"])
    })
})
