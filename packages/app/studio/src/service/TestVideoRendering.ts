import {asInstanceOf, DefaultObservableValue, Option, RuntimeNotifier} from "@opendaw/lib-std"
import {AudioData, RenderQuantum} from "@opendaw/lib-dsp"
import {Promises, Wait} from "@opendaw/lib-runtime"
import {FFmpegWorker, OfflineEngineRenderer, Project, WavFile} from "@opendaw/studio-core"
import {Files} from "@opendaw/lib-dom"
import {ShadertoyState} from "@/ui/shadertoy/ShadertoyState"
import {ShadertoyRunner} from "@/ui/shadertoy/ShadertoyRunner"
import {ShadertoyBox} from "@opendaw/studio-boxes"

const WIDTH = 1280
const HEIGHT = 720
const FPS = 30
const SAMPLE_RATE = 48_000
const DURATION_SECONDS = 10

export namespace TestVideoRendering {
    export const test = async (source: Project): Promise<void> => {
        const project = source.copy()
        const {boxGraph, timelineBox: {loopArea: {enabled}}} = project
        boxGraph.beginTransaction()
        enabled.setValue(false)
        boxGraph.endTransaction()

        // Load FFmpeg first (has its own progress dialog)
        const ffmpeg = await loadFFmpeg()

        const progressValue = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering video...",
            progress: progressValue
        })

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

            // Create renderer
            dialog.message = "Initializing renderer..."
            const renderer = await OfflineEngineRenderer.create(project, Option.None, SAMPLE_RATE)
            renderer.play()

            const totalFrames = DURATION_SECONDS * FPS
            const audioChunks: Float32Array[][] = []
            const tempoMap = project.tempoMap

            // Calculate samples per frame with error accumulation
            const idealSamplesPerFrame = SAMPLE_RATE / FPS
            let samplesRendered = 0

            // Render frames
            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                // Calculate target samples for end of this frame
                const targetSamples = Math.round((frameIndex + 1) * idealSamplesPerFrame)
                const samplesToRender = targetSamples - samplesRendered

                const quantumsNeeded = Math.ceil(samplesToRender / RenderQuantum)
                const actualSamplesToRender = quantumsNeeded * RenderQuantum

                const channels = await renderer.step(actualSamplesToRender)
                audioChunks.push(channels)
                samplesRendered += actualSamplesToRender

                // Update shadertoy state with offline position
                const seconds = renderer.totalFrames / SAMPLE_RATE
                const ppqn = tempoMap.secondsToPPQN(seconds)
                shadertoyState.setPPQN(ppqn) // TODO: this should be done by the offline audio engine renderer
                shadertoyRunner.render(seconds)

                // Capture frame as PNG
                const blob = await canvas.convertToBlob({type: "image/png"})
                const frameData = new Uint8Array(await blob.arrayBuffer())
                await ffmpeg.ffmpeg.writeFile(`frame_${String(frameIndex).padStart(6, "0")}.png`, frameData)

                // Update progress
                progressValue.setValue(frameIndex / totalFrames * 0.8)
                dialog.message = `Rendering frame ${frameIndex + 1}/${totalFrames}`

                // Yield to UI
                if (frameIndex % 10 === 0) {
                    await Wait.frame()
                }
            }

            renderer.stop()
            renderer.terminate()
            shadertoyState.terminate()
            shadertoyRunner.terminate()

            // Combine audio chunks into single buffer
            dialog.message = "Encoding audio..."
            const numberOfChannels = audioChunks[0].length
            const audioData = AudioData.create(SAMPLE_RATE, samplesRendered, numberOfChannels)
            for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex++) {
                let offset = 0
                for (const chunk of audioChunks) {
                    audioData.frames[channelIndex].set(chunk[channelIndex], offset)
                    offset += chunk[channelIndex].length
                }
            }

            // Write audio as WAV
            const wavData = WavFile.encodeFloats(audioData)
            await ffmpeg.ffmpeg.writeFile("audio.wav", new Uint8Array(wavData))

            // Combine video and audio with FFmpeg
            dialog.message = "Encoding video... (This takes a while)"
            progressValue.setValue(0.85)

            await ffmpeg.ffmpeg.exec([
                "-framerate", String(FPS),
                "-i", "frame_%06d.png",
                "-i", "audio.wav",
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "23",
                "-c:a", "aac",
                "-b:a", "192k",
                "-pix_fmt", "yuv420p",
                "-shortest",
                "-y",
                "output.mp4"
            ])

            progressValue.setValue(0.95)
            dialog.message = "Finalizing..."

            // Read output
            const outputData = await ffmpeg.ffmpeg.readFile("output.mp4")
            if (typeof outputData === "string") {
                throw new Error("Failed to read output video")
            }

            // Cleanup ffmpeg files
            const filesToClean = ["audio.wav", "output.mp4"]
            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                filesToClean.push(`frame_${String(frameIndex).padStart(6, "0")}.png`)
            }
            await ffmpeg.cleanupFiles(filesToClean)

            dialog.terminate()

            // Save file
            const approved = await RuntimeNotifier.approve({
                headline: "Save Video",
                message: `Size: ${(outputData.byteLength / 1024 / 1024).toFixed(1)}MB`,
                approveText: "Save"
            })
            if (approved) {
                await Files.save(new Uint8Array(outputData).buffer as ArrayBuffer, {suggestedName: "opendaw-video.mp4"})
            }
        } catch (error) {
            dialog.terminate()
            await RuntimeNotifier.info({
                headline: "Video Export Failed",
                message: String(error)
            })
            throw error
        }
    }

    const loadFFmpeg = async (): Promise<FFmpegWorker> => {
        const {FFmpegWorker} = await Promises.guardedRetry(
            () => import("@opendaw/studio-core/FFmpegWorker"),
            (_, count) => count < 60
        )
        const progressValue = new DefaultObservableValue(0.0)
        const progressDialog = RuntimeNotifier.progress({
            headline: "Loading FFmpeg...",
            progress: progressValue
        })
        const {status, value, error} = await Promises.tryCatch(
            FFmpegWorker.load(loadProgress => progressValue.setValue(loadProgress))
        )
        progressDialog.terminate()
        if (status === "rejected") {
            await RuntimeNotifier.info({
                headline: "Error",
                message: `Could not load FFmpeg: ${String(error)}`
            })
            throw error
        }
        return value
    }
}
