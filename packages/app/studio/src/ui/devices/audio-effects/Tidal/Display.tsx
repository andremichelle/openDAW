import css from "./Display.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Arrays, Lifecycle, TAU} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {TidalDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {TidalComputer} from "@opendaw/lib-dsp"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const className = Html.adoptStyleSheet(css, "Display")

type Construct = {
    lifecycle: Lifecycle
    adapter: TidalDeviceBoxAdapter
    liveStreamReceiver: LiveStreamReceiver
}

export const Display = ({lifecycle, adapter, liveStreamReceiver}: Construct) => {
    const computer = new TidalComputer()
    return (
        <div className={className}>
            <canvas onInit={canvas => {
                let processorPhase = 0.0
                const {depth, slope, symmetry, offset, channelOffset} = adapter.namedParameter
                const uMin = -0.5
                const uMax = 1.5
                const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {context, actualWidth, actualHeight, devicePixelRatio} = painter
                    const fullOffset = offset.getControlledValue() / 360.0
                    const channelPhase: number = channelOffset.getControlledValue() / 360.0
                    const padding = devicePixelRatio * 2
                    const top = padding
                    const bottom = actualHeight - padding
                    const xToValue = (x: number) => uMin + (x / actualWidth - uMin) * (uMax - uMin)
                    const valueToX = (value: number) => (value - uMin) / (uMax - uMin) * actualWidth
                    const valueToY = (value: number) => bottom + (top - bottom) * value
                    computer.set(depth.getControlledValue(), slope.getControlledValue(), symmetry.getControlledValue())

                    // edges
                    const x0 = valueToX(0.0)
                    const x1 = valueToX(1.0)
                    const y0 = valueToY(0.0)
                    const y1 = valueToY(1.0)
                    context.beginPath()
                    context.moveTo(x0, y0)
                    context.lineTo(x0, y1)
                    context.moveTo(x1, y0)
                    context.lineTo(x1, y1)
                    context.setLineDash([3, 3])
                    context.strokeStyle = DisplayPaint.strokeStyle(0.75)
                    context.stroke()

                    const curve = (u0: number, u1: number, opacity: number, phaseOffset: number) => {
                        const ud = fullOffset + phaseOffset
                        const x0 = valueToX(u0)
                        const x1 = valueToX(u1)
                        const path = new Path2D()
                        path.moveTo(x0, valueToY(computer.compute(u0 + ud)))
                        for (let x = x0; x <= x1; x++) {
                            path.lineTo(x, valueToY(computer.compute(xToValue(x) + ud)))
                        }
                        context.strokeStyle = DisplayPaint.strokeStyle(opacity * 0.75)
                        context.stroke(path)
                        path.lineTo(x1, actualHeight)
                        path.lineTo(x0, actualHeight)

                        const gradient = context.createLinearGradient(0, top, 0, bottom)
                        gradient.addColorStop(0.0, DisplayPaint.strokeStyle(0.08))
                        gradient.addColorStop(1.0, DisplayPaint.strokeStyle(0.02))
                        context.fillStyle = gradient
                        context.fill(path)
                    }

                    context.lineWidth = 2.0
                    context.setLineDash(Arrays.empty())

                    // Channel 0
                    curve(uMin, 0.0, 0.30, 0.0)
                    curve(0.0, 1.0, 0.90, 0.0)
                    curve(1.0, uMax, 0.30, 0.0)

                    // Channel 1
                    curve(uMin, 0.0, 0.10, channelPhase)
                    curve(0.0, 1.0, 0.20, channelPhase)
                    curve(1.0, uMax, 0.10, channelPhase)

                    const dot = (phase: number, offset: number, opacity: number) => {
                        const u = phase - Math.floor(phase)
                        const x = valueToX(u)
                        const y = valueToY(computer.compute(u + offset))
                        context.beginPath()
                        context.arc(x, y, 4.0, 0.0, TAU)
                        context.fillStyle = DisplayPaint.strokeStyle(opacity)
                        context.fill()
                    }

                    context.strokeStyle = "none"
                    dot(processorPhase, fullOffset, 1.0)
                    dot(processorPhase, fullOffset + channelPhase, 0.2)
                }))
                lifecycle.ownAll(
                    depth.subscribe(painter.requestUpdate),
                    slope.subscribe(painter.requestUpdate),
                    symmetry.subscribe(painter.requestUpdate),
                    offset.subscribe(painter.requestUpdate),
                    channelOffset.subscribe(painter.requestUpdate),
                    liveStreamReceiver.subscribeFloat(adapter.address.append(0), value => {
                        if (processorPhase !== value) {
                            processorPhase = value
                            painter.requestUpdate()
                        }
                    })
                )
            }}/>
        </div>
    )
}