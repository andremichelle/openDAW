import {StudioService} from "@/service/StudioService"
import {AudioUnitFactory, InstrumentFactories, ProjectSkeleton, TrackType} from "@moises-ai/studio-adapters"
import {AudioUnitType, IconSymbol} from "@moises-ai/studio-enums"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioTimeStretchBox,
    CaptureAudioBox,
    TrackBox,
    TransientMarkerBox,
    ValueEventCollectionBox,
    WarpMarkerBox
} from "@moises-ai/studio-boxes"
import {Option, Progress, UUID} from "@moises-ai/lib-std"
import {Project, SampleStorage, Workers} from "@moises-ai/studio-core"
import {PPQN, TimeBase} from "@moises-ai/lib-dsp"

export const testAudioProject = async (service: StudioService) => {
    const skeleton =
        ProjectSkeleton.empty({createDefaultUser: true, createOutputCompressor: false})
    const {boxGraph, mandatoryBoxes: {userInterfaceBoxes, timelineBox}} = skeleton
    boxGraph.beginTransaction()
    timelineBox.bpm.setValue(140)
    const audioUnitBox = AudioUnitFactory.create(skeleton,
        AudioUnitType.Instrument, Option.wrap(CaptureAudioBox.create(boxGraph, UUID.generate())))
    const tapeBox = InstrumentFactories.Tape
        .create(boxGraph, audioUnitBox.input, "Tape", IconSymbol.Play)
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.target.refer(tapeBox)
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(audioUnitBox.tracks)
    })
    const arrayBuffer = await fetch("test/Drum.02.wav").then(response => response.arrayBuffer())
    const sample = await service.sampleService.importFile({name: "Test", arrayBuffer, progressHandler: Progress.Empty})
    const uuid = UUID.parse(sample.uuid)
    const [audioData] = await SampleStorage.get().load(uuid)
    const transients = await Workers.Transients.detect(audioData)
    const audioFileBox = AudioFileBox.create(boxGraph, uuid, box => {
        box.endInSeconds.setValue(sample.duration)
    })

    transients.forEach(position => TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
        box.owner.refer(audioFileBox.transientMarkers)
        box.position.setValue(position)
    }))

    const durationInSeconds = audioData.numberOfFrames / audioData.sampleRate
    const valueEventCollectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    const timeStretchBox = AudioTimeStretchBox.create(boxGraph, UUID.generate())

    WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
        box.owner.refer(timeStretchBox.warpMarkers)
        box.position.setValue(0)
        box.seconds.setValue(0)
    })
    WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
        box.owner.refer(timeStretchBox.warpMarkers)
        box.position.setValue(PPQN.Bar * 2)
        box.seconds.setValue(durationInSeconds * 0.5)
    })
    WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
        box.owner.refer(timeStretchBox.warpMarkers)
        box.position.setValue(PPQN.Bar * 4)
        box.seconds.setValue(durationInSeconds)
    })
    const audioRegionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.timeBase.setValue(TimeBase.Musical)
        box.duration.setValue(PPQN.Bar * 4)
        box.loopDuration.setValue(PPQN.Bar * 4)
        box.file.refer(audioFileBox)
        box.events.refer(valueEventCollectionBox.owners)
        box.regions.refer(trackBox.regions)
        box.label.setValue("Test Audio Region")
        box.hue.setValue(180)
        box.playMode.refer(timeStretchBox)
    })

    userInterfaceBoxes[0].editingTimelineRegion.refer(audioRegionBox)
    userInterfaceBoxes[0].editingDeviceChain.refer(audioUnitBox.editing)

    boxGraph.endTransaction()
    service.projectProfileService.setProject(Project.fromSkeleton(service, skeleton), "Test Project")
}