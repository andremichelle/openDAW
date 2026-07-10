import {Arrays, Errors, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import SignalsmithStretch from "signalsmith-stretch"
import {AudioContentFactory, AudioFileBoxFactory, Project, SampleService, Workers} from "./index"

/**
 * Renders a time-stretch (warped) audio region offline through the Signalsmith Stretch engine
 * (STFT-based, "Complex"-grade quality) and replaces the region with a not-stretched region playing
 * the rendered result. The warp markers translate directly into the stretcher's piecewise-linear
 * schedule: each marker pair becomes one {output, input, rate} segment.
 */
export namespace AudioWarpRender {
    // the stretcher needs a little lead time to fill its analysis windows before the first marker
    const START_PAD_SECONDS = 0.25
    const TAIL_SECONDS = 0.1

    export const renderComplex = async (project: Project,
                                        sampleService: SampleService,
                                        regions: ReadonlyArray<AudioRegionBoxAdapter>): Promise<void> => {
        const stretchRegions = regions.filter(region =>
            region.asPlayModeTimeStretch.nonEmpty() || region.asPlayModePitchStretch.nonEmpty())
        if (stretchRegions.length === 0) {return}
        const dialog = RuntimeNotifier.progress({headline: "Rendering HQ Stretch..."})
        for (const region of stretchRegions) {
            dialog.message = region.label
            const result = await Promises.tryCatch(renderRegion(project, sampleService, region))
            if (result.status === "rejected") {
                dialog.terminate()
                if (!Errors.isAbort(result.error)) {
                    console.warn(result.error)
                    RuntimeNotifier.notify({message: "HQ Stretch render failed.", icon: "Warning"})
                }
                return
            }
        }
        dialog.terminate()
    }

    const renderRegion = async (project: Project,
                                sampleService: SampleService,
                                region: AudioRegionBoxAdapter): Promise<void> => {
        const playMode = region.asPlayModeTimeStretch.nonEmpty()
            ? region.asPlayModeTimeStretch.unwrap()
            : region.asPlayModePitchStretch.unwrap("Region has no warped play-mode")
        const markers = playMode.warpMarkers.asArray()
        if (markers.length < 2) {return Promise.reject(new Error("Region needs at least two warp markers"))}
        const data = await region.file.audioData
        const first = Arrays.getFirst(markers, "No first marker")
        const outputSeconds = markers.map(marker =>
            project.tempoMap.intervalToSeconds(region.position, region.position + (marker.position - first.position)))
        const totalSeconds = Arrays.getLast(outputSeconds, "No last marker")
        const semitones = region.asPlayModeTimeStretch.mapOr(stretch => Math.log2(stretch.playbackRate) * 12.0, 0.0)
        const sampleRate = sampleService.audioContext.sampleRate
        const rendered = await renderWarped(data, markers.map(({seconds}) => seconds), outputSeconds, semitones, sampleRate)
        const sample = await sampleService.importFile(
            {name: `${region.label} HQ`, arrayBuffer: WavFile.encodeFloats(rendered)})
        const sampleUuid = UUID.parse(sample.uuid)
        const audioFileBoxModifier = await AudioFileBoxFactory.createModifier(
            Workers.Transients, project.boxGraph, rendered, sampleUuid, sample.name)
        const trackBoxAdapter = region.trackBoxAdapter.unwrap("Has no trackAdapter")
        const {position, label} = region
        const gainInDb = region.gain.getValue()
        project.editing.modify(() => {
            const audioFileBox = audioFileBoxModifier()
            region.box.delete()
            AudioContentFactory.createNotStretchedRegion({
                boxGraph: project.boxGraph,
                targetTrack: trackBoxAdapter.box,
                audioFileBox,
                sample,
                position,
                name: label,
                gainInDb
            })
            project.trackUserCreatedSample(sampleUuid)
        })
        console.debug(`AudioWarpRender: rendered ${totalSeconds.toFixed(3)}s for "${label}"`)
    }

    // The stretcher's schedule() advances its internal segment map to each newly scheduled time, so a
    // timeline cannot be pre-scheduled up front: later entries would consume earlier ones. Instead the
    // context is suspended at every marker boundary and the next segment is scheduled "now" (the same
    // real-time pattern the node is designed for), then rendering resumes.
    const renderWarped = async (data: AudioData,
                                inputSeconds: ReadonlyArray<number>,
                                outputSeconds: ReadonlyArray<number>,
                                semitones: number,
                                sampleRate: number): Promise<AudioData> => {
        const totalSeconds = outputSeconds[outputSeconds.length - 1]
        const renderFrames = Math.ceil((START_PAD_SECONDS + totalSeconds + TAIL_SECONDS) * sampleRate)
        const context = new OfflineAudioContext(2, renderFrames, sampleRate)
        const node = await SignalsmithStretch(context, {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]})
        const left = data.frames[0]
        const right = data.frames.length > 1 ? data.frames[1] : data.frames[0]
        await node.addBuffers([left, right])
        const segmentRate = (index: number): number => {
            const outputSpan = outputSeconds[index + 1] - outputSeconds[index]
            return outputSpan > 0.0 ? (inputSeconds[index + 1] - inputSeconds[index]) / outputSpan : 1.0
        }
        const scheduleSegment = (index: number, outputTime: number, input: number) =>
            node.schedule({outputTime, output: outputTime, active: true, input, rate: segmentRate(index), semitones})
        const suspensions = Arrays.create(index => {
            const boundary = index + 1
            const when = START_PAD_SECONDS + outputSeconds[boundary]
            return context.suspend(when).then(async () => {
                if (boundary < inputSeconds.length - 1) {
                    await scheduleSegment(boundary, when, inputSeconds[boundary])
                } else {
                    await node.schedule({outputTime: when, output: when, active: false})
                }
                return context.resume()
            })
        }, inputSeconds.length - 1)
        const firstRate = segmentRate(0)
        await scheduleSegment(0, 0.0, inputSeconds[0] - START_PAD_SECONDS * firstRate)
        node.connect(context.destination)
        const [buffer] = await Promise.all([context.startRendering(), ...suspensions])
        const numFrames = Math.ceil(totalSeconds * sampleRate)
        const padFrames = Math.round(START_PAD_SECONDS * sampleRate)
        const rendered = AudioData.create(sampleRate, numFrames, 2)
        rendered.frames[0].set(buffer.getChannelData(0).subarray(padFrames, padFrames + numFrames))
        rendered.frames[1].set(buffer.getChannelData(1).subarray(padFrames, padFrames + numFrames))
        return rendered
    }
}
