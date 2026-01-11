import {asInstanceOf, DefaultObservableValue, Option, panic, RuntimeNotifier, TimeSpan} from "@opendaw/lib-std"
import {dbToGain, RenderQuantum} from "@opendaw/lib-dsp"
import {OfflineEngineRenderer, Project} from "@opendaw/studio-core"
import {Files} from "@opendaw/lib-dom"
import {ShadertoyState} from "@/ui/shadertoy/ShadertoyState"
import {ShadertoyRunner} from "@/ui/shadertoy/ShadertoyRunner"
import {ShadertoyBox} from "@opendaw/studio-boxes"
import {showVideoExportDialog, VideoOverlay, WebCodecsVideoExporter} from "@/video"

const MAX_DURATION_SECONDS = TimeSpan.hours(1).absSeconds()
const SILENCE_THRESHOLD_DB = -72.0
const SILENCE_DURATION_SECONDS = 10

export namespace VideoRenderer {
    export const render = async (source: Project, projectName: string, sampleRate: number): Promise<void> => {
        if (!WebCodecsVideoExporter.isSupported()) {
            return panic("WebCodecs is not supported in this browser")
        }

        const config = await showVideoExportDialog(sampleRate)
        const {width, height, frameRate, previewDuration} = config

        console.time("Render Video")
        const project = source.copy()
        const {boxGraph, timelineBox: {loopArea: {enabled}}} = project
        boxGraph.beginTransaction()
        enabled.setValue(false)
        boxGraph.endTransaction()

        let rendering = true

        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering video...",
            progress: progress,
            cancel: () => rendering = false
        })

        const exportConfig = {
            width,
            height,
            frameRate,
            sampleRate,
            numberOfChannels: 2
        }

        dialog.message = "Initializing..."
        const exporter = await WebCodecsVideoExporter.create(exportConfig)

        try {
            const shadertoyCanvas = new OffscreenCanvas(width, height)
            const shadertoyContext = shadertoyCanvas.getContext("webgl2")!
            const shadertoyState = new ShadertoyState(project)
            const shadertoyRunner = new ShadertoyRunner(shadertoyState, shadertoyContext)
            const shadertoy = project.rootBoxAdapter.box.shadertoy
            if (shadertoy.nonEmpty()) {
                const code = asInstanceOf(shadertoy.targetVertex.unwrap().box, ShadertoyBox).shaderCode.getValue()
                shadertoyRunner.compile(code)
            }
            const compositionCanvas = new OffscreenCanvas(width, height)
            const compositionCtx = compositionCanvas.getContext("2d")!
            const overlay = await VideoOverlay.create({width, height, projectName})

            const renderer = await OfflineEngineRenderer.create(project, Option.None, sampleRate)
            renderer.play()

            const tempoMap = project.tempoMap
            const estimatedDurationInSeconds = previewDuration > 0
                ? previewDuration
                : tempoMap.ppqnToSeconds(project.lastRegionAction())
            const maxDuration = previewDuration > 0
                ? previewDuration
                : MAX_DURATION_SECONDS
            const maxFrames = Math.ceil(maxDuration * frameRate)
            const estimatedNumberOfFrames = Math.ceil(estimatedDurationInSeconds * frameRate)

            const silenceThreshold = dbToGain(SILENCE_THRESHOLD_DB)
            const silenceSamplesNeeded = Math.ceil(SILENCE_DURATION_SECONDS * sampleRate)
            let consecutiveSilentSamples = 0
            let hasHadAudio = false

            const idealSamplesPerFrame = sampleRate / frameRate
            let samplesRendered = 0
            let frameIndex = 0

            while (frameIndex < maxFrames && rendering) {
                dialog.message = `Rendering ${frameIndex + 1} of estimated ${estimatedNumberOfFrames} frames`
                progress.setValue(frameIndex / estimatedNumberOfFrames)

                const targetSamples = Math.round((frameIndex + 1) * idealSamplesPerFrame)
                const samplesToRender = targetSamples - samplesRendered
                const quantumsNeeded = Math.ceil(samplesToRender / RenderQuantum)
                const actualSamplesToRender = quantumsNeeded * RenderQuantum
                const channels = await renderer.step(actualSamplesToRender)
                samplesRendered += actualSamplesToRender

                if (previewDuration === 0) {
                    let maxSample = 0
                    for (const channel of channels) {
                        for (const sample of channel) {
                            const absoluteValue = Math.abs(sample)
                            if (absoluteValue > maxSample) {maxSample = absoluteValue}
                        }
                    }
                    if (maxSample > silenceThreshold) {
                        hasHadAudio = true
                        consecutiveSilentSamples = 0
                    } else if (hasHadAudio) {
                        consecutiveSilentSamples += actualSamplesToRender
                        if (consecutiveSilentSamples >= silenceSamplesNeeded) {
                            break
                        }
                    }
                }

                const seconds = renderer.totalFrames / sampleRate
                const ppqn = tempoMap.secondsToPPQN(seconds)
                shadertoyState.setPPQN(ppqn)
                shadertoyRunner.render(seconds)

                compositionCtx.drawImage(shadertoyCanvas, 0, 0)
                overlay.render(ppqn)
                compositionCtx.globalCompositeOperation = "screen"
                compositionCtx.drawImage(overlay.canvas, 0, 0)
                compositionCtx.globalCompositeOperation = "source-over"

                const timestampSeconds = frameIndex / frameRate
                await exporter.addFrame(compositionCanvas, channels, timestampSeconds)
                frameIndex++
            }

            renderer.stop()
            renderer.terminate()
            shadertoyState.terminate()
            shadertoyRunner.terminate()
            overlay.terminate()

            if (!rendering) {
                dialog.terminate()
                exporter.terminate()
                return
            }

            dialog.message = "Finalizing video..."
            const outputData = await exporter.finalize()
            dialog.terminate()

            const approved = await RuntimeNotifier.approve({
                headline: "Save Video",
                message: `Size: ${(outputData.byteLength / 1024 / 1024).toFixed(1)}MB`,
                approveText: "Save"
            })
            if (approved) {
                await Files.save(outputData.buffer as ArrayBuffer, {suggestedName: "opendaw-video.mp4"})
            }
        } catch (error) {
            dialog.terminate()
            exporter.terminate()
            await RuntimeNotifier.info({
                headline: "Video Export Failed",
                message: String(error)
            })
            throw error
        }

        console.timeEnd("Render Video")
    }
}
