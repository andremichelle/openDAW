import {Arrays, Errors, isDefined, Option, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioData, RegionCollection} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {AudioRegionBoxAdapter, ExportStemsConfiguration} from "@opendaw/studio-adapters"
import {
    AudioContentFactory,
    AudioFileBoxFactory,
    OfflineEngineRenderer,
    Project,
    SampleService,
    WavFile,
    Workers
} from "@opendaw/studio-core"

export namespace AudioConsolidation {
    export const flatten = async (project: Project,
                                  sampleService: SampleService,
                                  regions: ReadonlyArray<AudioRegionBoxAdapter>,
                                  abortSignal?: AbortSignal): Promise<void> => {
        if (regions.length === 0) {return}
        const sorted = regions.toSorted(RegionCollection.Comparator)
        const first = Arrays.getFirst(sorted, "No first region")
        const last = Arrays.getLast(sorted, "No last region")
        const rangeMin = first.position
        const rangeMax = last.complete
        const trackBoxAdapter = first.trackBoxAdapter.unwrap("Has no trackAdapter")
        const audioUnitUuid = UUID.toString(trackBoxAdapter.audioUnit.address.uuid)
        const sampleRate = sampleService.audioContext.sampleRate
        const durationSeconds = project.tempoMap.intervalToSeconds(rangeMin, rangeMax)
        const numSamples = Math.ceil(durationSeconds * sampleRate)
        const exportConfiguration: ExportStemsConfiguration = {
            [audioUnitUuid]: {
                includeAudioEffects: false,
                includeSends: false,
                useInstrumentOutput: true,
                fileName: `Merged ${first.file.fileName}`
            }
        }
        const selectedUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
        sorted.forEach(region => selectedUuids.add(region.uuid))
        const allRegionsInRange = [...trackBoxAdapter.regions.collection.iterateRange(rangeMin, rangeMax)]
        const nonSelectedUuids = allRegionsInRange
            .filter(region => !selectedUuids.hasKey(region.uuid))
            .map(region => region.uuid)
        const copiedProject = project.copy()
        copiedProject.boxGraph.beginTransaction()
        nonSelectedUuids.forEach(uuid => copiedProject.boxGraph.findBox(uuid).ifSome(box => box.delete()))
        copiedProject.boxGraph.endTransaction()
        const abortController = new AbortController()
        if (isDefined(abortSignal)) {
            abortSignal.addEventListener("abort", () => abortController.abort())
        }
        const dialog = RuntimeNotifier.progress({
            headline: "Flattening Audio Regions...",
            cancel: () => abortController.abort()
        })
        const renderResult = await Promises.tryCatch((async () => {
            const renderer = await OfflineEngineRenderer.create(copiedProject, Option.wrap(exportConfiguration), sampleRate)
            try {
                await renderer.waitForLoading()
                renderer.setPosition(rangeMin)
                renderer.play()
                await renderer.waitForLoading()
                const channels = await renderer.step(numSamples)
                const audioData = AudioData.create(sampleRate, numSamples, 2)
                audioData.frames[0].set(channels[0])
                audioData.frames[1].set(channels[1])
                return audioData
            } finally {
                renderer.terminate()
            }
        })())
        if (renderResult.status === "rejected") {
            dialog.terminate()
            if (!Errors.isAbort(renderResult.error)) {
                await RuntimeNotifier.info({headline: "Flatten Failed", message: String(renderResult.error)})
            }
            return
        }
        const audioData = renderResult.value
        dialog.message = "Importing sample..."
        const importResult = await Promises.tryCatch(
            sampleService.importFile({name: "flatten", arrayBuffer: WavFile.encodeFloats(audioData)}))
        if (importResult.status === "rejected") {
            dialog.terminate()
            await RuntimeNotifier.info({headline: "Flatten Failed", message: String(importResult.error)})
            return
        }
        const sample = importResult.value
        const sampleUuid = UUID.parse(sample.uuid)
        dialog.message = "Creating region..."
        const audioFileBoxModifier = await AudioFileBoxFactory.createModifier(
            Workers.Transients, project.boxGraph, audioData, sampleUuid, sample.name)
        dialog.terminate()
        project.editing.modify(() => {
            const audioFileBox = audioFileBoxModifier()
            allRegionsInRange.forEach(region => region.box.delete())
            AudioContentFactory.createNotStretchedRegion({
                boxGraph: project.boxGraph,
                targetTrack: trackBoxAdapter.box,
                audioFileBox,
                sample,
                position: rangeMin,
                name: first.label
            })
            project.trackUserCreatedSample(sampleUuid)
        })
    }
}
