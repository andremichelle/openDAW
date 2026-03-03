import css from "./Display.sass?inline"
import {AnimationFrame, Context2d, Html} from "@opendaw/lib-dom"
import {int, Lifecycle, TAU} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {DattorroReverbDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"

const className = Html.adoptStyleSheet(css, "Display")

type Construct = {
    lifecycle: Lifecycle
    liveStreamReceiver: LiveStreamReceiver
    adapter: DattorroReverbDeviceBoxAdapter
    gridUV: { u: int, v: int }
}

type Particle = {
    unitX: number
    unitY: number
    unitZ: number
    energy: number
}

export const Display = ({lifecycle, liveStreamReceiver, adapter, gridUV: {u, v}}: Construct) => {
    const {bandwidth, decay, damping} = adapter.namedParameter
    let maxPeak = 0.0
    return (
        <div className={className} style={{gridArea: `${v + 1}/${u + 1}/auto/span 3`}}>
            <canvas onInit={canvas => {
                const padding = 8
                const project = (x: number, z: number, focalLength: number): number =>
                    x * focalLength / (focalLength + z)
                const particles: Particle[] = Array.from({length: 500}, () => ({
                    unitX: (Math.random() - Math.random()) * 0.5 + 0.5,
                    unitY: (Math.random() - Math.random()) * 0.25 + 0.75, // push to center
                    unitZ: Math.random(),
                    energy: 0.0
                }))
                const canvasPainter = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {context, actualWidth, actualHeight, devicePixelRatio} = painter
                    const x1 = actualWidth - padding
                    const y1 = actualHeight - padding
                    const decayValue = decay.getControlledValue()
                    const alphaExp = 1.0 + damping.getControlledValue() * 4.0
                    context.lineWidth = 1.0 / devicePixelRatio
                    context.strokeStyle = DisplayPaint.strokeStyle()
                    const cx = x1 * 0.5
                    const cy = y1 * 0.5
                    const numberOfBoxes = 24
                    const focalLength = 500.0
                    const maxZ = numberOfBoxes * (10.0 + decayValue * 90.0)
                    const x0 = padding + cx * (0.75 - bandwidth.getControlledValue() * 0.75)
                    const y0 = padding
                    for (let i = 0; i < numberOfBoxes; i++) {
                        const z = i * (10.0 + decayValue * 90.0)
                        const x = project(x0 - cx, z, focalLength) + cx
                        const y = project(y0 - cy, z, focalLength) + cy
                        const scale = focalLength / (focalLength + z)
                        const width = (cx - x0) * 2.0 * scale
                        const height = (cy - y0) * 2.0 * scale
                        context.globalAlpha = (1.0 - i / numberOfBoxes) ** alphaExp
                        Context2d.strokeRoundedRect(context, x, y, width, height, 8)
                    }
                    context.fillStyle = DisplayPaint.strokeStyle()
                    for (const particle of particles) {
                        const worldX = x0 + particle.unitX * 2.0 * (cx - x0)
                        const worldY = y0 + particle.unitY * 2.0 * (cy - y0)
                        const worldZ = particle.unitZ * maxZ
                        const x = project(worldX - cx, worldZ, focalLength) + cx
                        const y = project(worldY - cy, worldZ, focalLength) + cy
                        const scale = focalLength / (focalLength + worldZ)
                        context.globalAlpha = particle.energy * 0.5
                        context.beginPath()
                        context.arc(x, y, 2.0 * scale, 0.0, TAU)
                        context.fill()
                    }
                    particles.forEach(particle => {
                        particle.unitZ += 0.01
                        if (particle.unitZ > 1.0) {
                            particle.unitZ -= 1.0
                            particle.energy = maxPeak
                        } else {
                            particle.energy *= 0.98
                        }
                    })
                    maxPeak *= 0.96
                }))
                lifecycle.ownAll(
                    bandwidth.subscribe(canvasPainter.requestUpdate),
                    decay.subscribe(canvasPainter.requestUpdate),
                    AnimationFrame.add(canvasPainter.requestUpdate),
                    liveStreamReceiver.subscribeFloats(adapter.address, ([l, r]) => {
                        maxPeak = Math.max(maxPeak, l, r)
                    })
                )
                return canvasPainter
            }}/>
        </div>
    )
}