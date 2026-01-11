import {PPQN} from "@opendaw/lib-dsp"
import {Events} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {VideoOverlay} from "./VideoOverlay"

const WIDTH = 1280
const HEIGHT = 720
const BPM = 120

type Construct = {
    lifecycle: Lifecycle
}

export const VideoOverlayPreview = ({lifecycle}: Construct) => {
    return (
        <div style={{
            margin: "0",
            background: "#111",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: "16px"
        }}>
            <canvas width={WIDTH} height={HEIGHT} style={{
                maxWidth: "90vw",
                maxHeight: "80vh",
                border: "1px solid #333",
                borderRadius: "4px"
            }} onInit={async canvas => {
                const ctx = canvas.getContext("2d")!
                const overlay = await VideoOverlay.create({
                    width: WIDTH,
                    height: HEIGHT,
                    projectName: "Dub Techno"
                })
                lifecycle.own(overlay)

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

                const slider = canvas.parentElement!.querySelector("input[type=range]") as HTMLInputElement
                lifecycle.own(Events.subscribe(slider, "input", () => render(parseFloat(slider.value))))
                render(0)
            }}/>
            <input type="range" min="0" max="2" value="0" step="0.00001" style={{width: "400px"}}/>
        </div>
    )
}
