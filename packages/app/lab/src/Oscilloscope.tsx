import {Lifecycle} from "@moises-ai/lib-std"

export interface OscilloscopeProps {
    lifecycle: Lifecycle
    analyser: AnalyserNode
}

export const Oscilloscope = (props: OscilloscopeProps): HTMLElement => {
    const {analyser, lifecycle} = props

    const canvas = document.createElement("canvas")
    canvas.width = 400
    canvas.height = 150
    canvas.style.border = "1px solid #333"
    canvas.style.backgroundColor = "#000"
    canvas.style.display = "block"

    const ctx = canvas.getContext("2d")!
    const dataArray = new Float32Array(analyser.fftSize)
    let animationId: number

    const findZeroCrossing = (data: Float32Array, start: number): number => {
        let i = start
        // Find a positive-going zero crossing
        while (i < data.length - 1) {
            if (data[i] <= 0 && data[i + 1] > 0) {
                return i
            }
            i++
        }
        return start
    }

    const draw = () => {
        animationId = requestAnimationFrame(draw)

        analyser.getFloatTimeDomainData(dataArray)

        // Find zero crossing for stable display
        const start = findZeroCrossing(dataArray, 0)

        // Find next zero crossing to determine one cycle
        let end = findZeroCrossing(dataArray, start + 10)
        if (end <= start) {
            end = Math.min(start + 200, dataArray.length - 1)
        }

        const cycleLength = end - start

        // Clear canvas
        ctx.fillStyle = "#000"
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        // Draw grid
        ctx.strokeStyle = "#222"
        ctx.lineWidth = 1

        // Horizontal lines
        for (let i = 0; i <= 4; i++) {
            const y = (canvas.height / 4) * i
            ctx.beginPath()
            ctx.moveTo(0, y)
            ctx.lineTo(canvas.width, y)
            ctx.stroke()
        }

        // Vertical lines (quarters of cycle)
        for (let i = 0; i <= 4; i++) {
            const x = (canvas.width / 4) * i
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, canvas.height)
            ctx.stroke()
        }

        // Draw center line
        ctx.strokeStyle = "#444"
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(0, canvas.height / 2)
        ctx.lineTo(canvas.width, canvas.height / 2)
        ctx.stroke()

        // Draw waveform (one cycle)
        ctx.strokeStyle = "#0f0"
        ctx.lineWidth = 2
        ctx.beginPath()

        for (let i = 0; i < cycleLength && (start + i) < dataArray.length; i++) {
            const x = (i / cycleLength) * canvas.width
            const v = dataArray[start + i]
            const y = (canvas.height / 2) - (v * canvas.height / 2.2) // 2.2 for some margin

            if (i === 0) {
                ctx.moveTo(x, y)
            } else {
                ctx.lineTo(x, y)
            }
        }

        ctx.stroke()
    }

    // Start animation
    draw()

    // Cleanup on lifecycle termination
    lifecycle.own({
        terminate: () => {
            cancelAnimationFrame(animationId)
        }
    })

    return canvas
}
