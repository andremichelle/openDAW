import {DefaultObservableValue, Option, RuntimeNotifier} from "@opendaw/lib-std"
import {AudioData, PPQN, RenderQuantum, TempoMap} from "@opendaw/lib-dsp"
import {Promises, Wait} from "@opendaw/lib-runtime"
import {FFmpegWorker, OfflineEngineRenderer, Project, WavFile} from "@opendaw/studio-core"
import {Files} from "@opendaw/lib-dom"

const WIDTH = 1280
const HEIGHT = 720
const FPS = 30
const SAMPLE_RATE = 48_000
const DURATION_SECONDS = 20

export namespace TestVideoRendering {
    export const test = async (project: Project): Promise<void> => {
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
            const ctx = canvas.getContext("2d")!
            ctx.fillStyle = "#1a1a2e"
            ctx.fillRect(0, 0, WIDTH, HEIGHT)

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

                // Round up to nearest multiple of RENDER_QUANTUM
                const quantumsNeeded = Math.ceil(samplesToRender / RenderQuantum)
                const actualSamplesToRender = quantumsNeeded * RenderQuantum

                const channels = await renderer.step(actualSamplesToRender)
                audioChunks.push(channels)
                samplesRendered += actualSamplesToRender

                // Draw frame
                drawFrame(ctx, frameIndex, renderer.totalFrames, tempoMap)

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
            dialog.message = "Encoding video..."
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

    const drawFrame = (
        ctx: OffscreenCanvasRenderingContext2D,
        frameIndex: number,
        totalSamples: number,
        tempoMap: TempoMap
    ): void => {
        // Clear
        ctx.fillStyle = "#1a1a2e"
        ctx.fillRect(0, 0, WIDTH, HEIGHT)

        // Calculate time values
        const seconds = totalSamples / SAMPLE_RATE
        const ppqn = tempoMap.secondsToPPQN(seconds)
        const bpm = tempoMap.getTempoAt(ppqn)
        const {bars, beats, semiquavers, ticks} = PPQN.toParts(ppqn)

        // Draw background gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT)
        gradient.addColorStop(0, "#1a1a2e")
        gradient.addColorStop(1, "#16213e")
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, WIDTH, HEIGHT)

        // Draw decorative lines
        ctx.strokeStyle = "#0f3460"
        ctx.lineWidth = 1
        for (let y = 0; y < HEIGHT; y += 40) {
            ctx.beginPath()
            ctx.moveTo(0, y)
            ctx.lineTo(WIDTH, y)
            ctx.stroke()
        }

        // Main time display
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"

        // Musical time (large)
        ctx.fillStyle = "#e94560"
        ctx.font = "bold 120px monospace"
        const musicalTime = `${bars + 1}.${beats + 1}.${semiquavers + 1}`
        ctx.fillText(musicalTime, WIDTH / 2, HEIGHT / 2 - 80)

        // Ticks
        ctx.fillStyle = "#f1f1f1"
        ctx.font = "bold 60px monospace"
        ctx.fillText(`:${String(ticks).padStart(3, "0")}`, WIDTH / 2, HEIGHT / 2 + 20)

        // Time in seconds
        ctx.fillStyle = "#a1a1a1"
        ctx.font = "36px monospace"
        const minutes = Math.floor(seconds / 60)
        const secs = seconds % 60
        const timeString = `${String(minutes).padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`
        ctx.fillText(timeString, WIDTH / 2, HEIGHT / 2 + 100)

        // BPM display
        ctx.fillStyle = "#00d9ff"
        ctx.font = "bold 48px monospace"
        ctx.fillText(`${bpm.toFixed(1)} BPM`, WIDTH / 2, HEIGHT / 2 + 180)

        // Frame and sample info (smaller, bottom)
        ctx.fillStyle = "#666"
        ctx.font = "24px monospace"
        ctx.fillText(`Frame: ${frameIndex + 1} | Samples: ${totalSamples}`, WIDTH / 2, HEIGHT - 40)

        // Progress bar
        const progress = frameIndex / (DURATION_SECONDS * FPS)
        const barWidth = WIDTH - 100
        const barHeight = 8
        const barX = 50
        const barY = HEIGHT - 80

        ctx.fillStyle = "#333"
        ctx.fillRect(barX, barY, barWidth, barHeight)
        ctx.fillStyle = "#e94560"
        ctx.fillRect(barX, barY, barWidth * progress, barHeight)
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
