import {asInstanceOf, DefaultObservableValue, Option, RuntimeNotifier} from "@opendaw/lib-std"
import {dbToGain, RenderQuantum} from "@opendaw/lib-dsp"
import {Wait} from "@opendaw/lib-runtime"
import {OfflineEngineRenderer, Project} from "@opendaw/studio-core"
import {Files} from "@opendaw/lib-dom"
import {ShadertoyState} from "@/ui/shadertoy/ShadertoyState"
import {ShadertoyRunner} from "@/ui/shadertoy/ShadertoyRunner"
import {ShadertoyBox} from "@opendaw/studio-boxes"
import {WebCodecsVideoExporter} from "@/video/index"

const WIDTH = 1280
const HEIGHT = 720
const FPS = 30
const SAMPLE_RATE = 48_000
const MAX_DURATION_SECONDS = 600
const SILENCE_THRESHOLD_DB = -72.0
const SILENCE_DURATION_SECONDS = 10

export namespace VideoRenderer {
    export const test = async (source: Project): Promise<void> => {
        console.time("Render Video")
        const project = source.copy()
        const {boxGraph, timelineBox: {loopArea: {enabled}}} = project
        boxGraph.beginTransaction()
        enabled.setValue(false)
        boxGraph.endTransaction()

        const progressValue = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering video...",
            progress: progressValue
        })

        const exportConfig = {
            width: WIDTH,
            height: HEIGHT,
            frameRate: FPS,
            sampleRate: SAMPLE_RATE,
            numberOfChannels: 2
        }

        if (!WebCodecsVideoExporter.isSupported()) {
            dialog.terminate()
            throw new Error("WebCodecs is not supported in this browser")
        }

        dialog.message = "Initializing..."
        const exporter = await WebCodecsVideoExporter.create(exportConfig)

        try {
            // Create canvas
            const canvas = new OffscreenCanvas(WIDTH, HEIGHT)
            const ctx = canvas.getContext("webgl2")!

            const shadertoyState = new ShadertoyState(project)
            const shadertoyRunner = new ShadertoyRunner(shadertoyState, ctx)

            const shadertoy = project.rootBoxAdapter.box.shadertoy
            if (shadertoy.nonEmpty()) {
                const code = asInstanceOf(shadertoy.targetVertex.unwrap().box, ShadertoyBox).shaderCode.getValue()
                shadertoyRunner.compile(code)
            }

            // Create audio renderer
            const renderer = await OfflineEngineRenderer.create(project, Option.None, SAMPLE_RATE)
            renderer.play()

            const maxFrames = MAX_DURATION_SECONDS * FPS
            const tempoMap = project.tempoMap

            // Silence detection
            const silenceThreshold = dbToGain(SILENCE_THRESHOLD_DB)
            const silenceSamplesNeeded = Math.ceil(SILENCE_DURATION_SECONDS * SAMPLE_RATE)
            let consecutiveSilentSamples = 0
            let hasHadAudio = false

            // Calculate samples per frame with error accumulation
            const idealSamplesPerFrame = SAMPLE_RATE / FPS
            let samplesRendered = 0
            let frameIndex = 0

            // Render frames until silence detected or max duration reached
            while (frameIndex < maxFrames) {
                // Calculate target samples for end of this frame
                const targetSamples = Math.round((frameIndex + 1) * idealSamplesPerFrame)
                const samplesToRender = targetSamples - samplesRendered

                const quantumsNeeded = Math.ceil(samplesToRender / RenderQuantum)
                const actualSamplesToRender = quantumsNeeded * RenderQuantum

                const channels = await renderer.step(actualSamplesToRender)
                samplesRendered += actualSamplesToRender

                // Check for silence
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

                // Update shadertoy state with offline position
                const seconds = renderer.totalFrames / SAMPLE_RATE
                const ppqn = tempoMap.secondsToPPQN(seconds)
                shadertoyState.setPPQN(ppqn)
                shadertoyRunner.render(seconds)

                // Add frame to exporter
                const timestampSeconds = frameIndex / FPS
                await exporter.addFrame(canvas, channels, timestampSeconds)

                // Update progress
                progressValue.setValue(frameIndex / maxFrames * 0.9)
                dialog.message = `Rendering frame ${frameIndex + 1}`

                // Yield to UI
                if (frameIndex % 10 === 0) {
                    await Wait.frame()
                }

                frameIndex++
            }

            renderer.stop()
            renderer.terminate()
            shadertoyState.terminate()
            shadertoyRunner.terminate()

            // Finalize video
            dialog.message = "Finalizing video..."
            progressValue.setValue(0.95)
            const outputData = await exporter.finalize()

            dialog.terminate()

            // Save file
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
