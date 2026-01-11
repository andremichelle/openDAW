import {PPQN} from "@opendaw/lib-dsp"
import {VideoOverlay} from "./VideoOverlay"

const WIDTH = 1280
const HEIGHT = 720
const BPM = 120

export const startVideoOverlayPreview = async (): Promise<void> => {
    document.body.style.cssText = "margin:0;background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;"

    const canvas = document.createElement("canvas")
    canvas.width = WIDTH
    canvas.height = HEIGHT
    canvas.style.cssText = "max-width:90vw;max-height:80vh;border:1px solid #333;border-radius:4px;"
    document.body.appendChild(canvas)

    const ctx = canvas.getContext("2d")!

    const slider = document.createElement("input")
    slider.type = "range"
    slider.min = "0"
    slider.max = "2"
    slider.value = "0"
    slider.step = "0.00001"
    slider.style.cssText = "width:400px;"
    document.body.appendChild(slider)

    const overlay = await VideoOverlay.create({
        width: WIDTH,
        height: HEIGHT,
        projectName: "Dub Techno"
    })

    const render = (seconds: number): void => {
        const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
        gradient.addColorStop(0, "#1a0a2e")
        gradient.addColorStop(0.5, "#16213e")
        gradient.addColorStop(1, "#0f3460")
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, WIDTH, HEIGHT)

        const ppqn = PPQN.secondsToPulses(seconds, BPM)
        overlay.render(ppqn)
        ctx.globalCompositeOperation = "screen"
        ctx.drawImage(overlay.canvas, 0, 0)
        ctx.globalCompositeOperation = "source-over"
    }

    slider.addEventListener("input", () => render(parseFloat(slider.value)))
    render(0)
}
