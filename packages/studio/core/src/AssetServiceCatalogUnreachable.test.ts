import {describe, expect, it} from "vitest"
import {isDefined, RuntimeNotification, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, Sample, TrackType} from "@opendaw/studio-adapters"
import {AssetService} from "./AssetService"
import {FilePickerAcceptTypes} from "./FilePickerAcceptTypes"

// Reproduces live error 1096 (TypeError: Failed to fetch). Opening a project runs replaceMissingFiles, which
// awaits the stock catalog over the network. A rejected fetch escaped all the way out of
// ProjectProfileService.load, leaving the "Loading..." monolog on screen forever. The catalog must not be
// degraded to an empty list either: every stock asset would then look missing and open a browse dialog.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const approvals: Array<string> = []
RuntimeNotifier.install({
    info: async () => {},
    approve: async (request: RuntimeNotification.ApproveRequest) => {
        approvals.push(request.message)
        return false
    },
    progress: () => ({message: "", terminate: () => {}}),
    notify: () => {}
})

class TestSampleService extends AssetService<Sample, void> {
    protected readonly nameSingular: string = "Sample"
    protected readonly namePlural: string = "Samples"
    protected readonly boxType = AudioFileBox
    protected readonly filePickerOptions: FilePickerOptions = FilePickerAcceptTypes.WavFiles

    constructor(readonly catalog: () => Promise<ReadonlyArray<Sample>>) {super()}

    async importFile(): Promise<Sample> {return Promise.reject("not expected")}

    protected async collectAllFiles(): Promise<ReadonlyArray<Sample>> {return this.catalog()}
}

const createGraphWithMissingFile = () => {
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} =
        ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const audioFileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.fileName.setValue("missing.wav")
        box.endInSeconds.setValue(1.0)
    })
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(PPQN.Bar)
        box.loopDuration.setValue(PPQN.Bar)
        box.timeBase.setValue(TimeBase.Musical)
        box.regions.refer(trackBox.regions)
        box.file.refer(audioFileBox)
        box.events.refer(events.owners)
    })
    boxGraph.endTransaction()
    return boxGraph
}

const manager = {invalidate: () => {}}

describe("replaceMissingFiles with an unreachable catalog (live error 1096)", () => {
    it("resolves instead of rejecting when the catalog fetch fails", async () => {
        approvals.length = 0
        const service = new TestSampleService(() => Promise.reject(new TypeError("Failed to fetch")))
        await expect(service.replaceMissingFiles(createGraphWithMissingFile(), manager)).resolves.toBeUndefined()
    })

    it("does not report stock assets as missing when the catalog is unreachable", async () => {
        approvals.length = 0
        const service = new TestSampleService(() => Promise.reject(new TypeError("Failed to fetch")))
        await service.replaceMissingFiles(createGraphWithMissingFile(), manager)
        expect(approvals).toEqual([])
    })

    it("still asks about a genuinely missing file when the catalog is reachable", async () => {
        approvals.length = 0
        const service = new TestSampleService(() => Promise.resolve([]))
        await service.replaceMissingFiles(createGraphWithMissingFile(), manager)
        expect(approvals).toHaveLength(1)
        expect(approvals[0]).toContain("missing.wav")
    })
})
