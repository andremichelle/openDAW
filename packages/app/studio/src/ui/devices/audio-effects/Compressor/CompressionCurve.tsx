import css from "./CompressionCurve.sass?inline"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Lifecycle, TAU} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CompressorDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter"
import {Vertical} from "@/ui/devices/audio-effects/Compressor/Vertical"
import {GainComputer} from "@opendaw/lib-dsp/ctagdrc"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

const className = Html.adoptStyleSheet(css, "CompressionCurve")

type Construct = {
    lifecycle: Lifecycle
    adapter: CompressorDeviceBoxAdapter
    values: Float32Array
}

export const CompressionCurve = ({lifecycle, adapter, values}: Construct) => {
    const {padding, innerHeight: size, scale} = Vertical
    const {threshold, ratio, knee} = adapter.namedParameter
    const numSegments = 7
    const segmentSize = size / numSegments
    const gridColor = "hsla(200, 40%, 70%, 0.12)"
    const computer = new GainComputer()
    return (
        <div className={className}>
            <canvas
                style={{
                    top: `${padding}px`,
                    left: `${padding}px`,
                    width: `calc(100% - ${padding * 2}px)`,
                    height: `calc(100% - ${padding * 2}px)`,
                    borderRadius: `${segmentSize / 2}px ${segmentSize / 2}px 0 ${segmentSize / 2}px`,
                    outline: `1px solid ${gridColor}`
                }}
                onInit={canvas => {
                    const canvasPainter = lifecycle.own(new CanvasPainter(canvas, painter => {
                        const {context, devicePixelRatio} = painter
                        context.scale(devicePixelRatio, devicePixelRatio)
                        context.save()
                        context.lineWidth = 1.0 / devicePixelRatio
                        context.beginPath()
                        for (let i = 1; i < numSegments; i++) {
                            const pos = Math.round(i * segmentSize)
                            context.moveTo(pos, 0)
                            context.lineTo(pos, size)
                            context.moveTo(0, pos)
                            context.lineTo(size, pos)
                        }
                        context.strokeStyle = gridColor
                        context.stroke()

                        const drawPath = (x0: number, x1: number, stroke: boolean): void => {
                            const path2D = new Path2D()
                            for (let x = x0; x <= x1; x++) {
                                const db = scale.normToUnit(1.0 - x / size)
                                const cp = computer.applyCompression(-db) - db
                                const y = Math.min(scale.unitToNorm(-cp) * size, size)
                                if (x === 0) {
                                    path2D.moveTo(x, y)
                                } else {
                                    path2D.lineTo(x, y)
                                }
                            }
                            if (stroke) {
                                context.lineWidth = 1.5
                                context.fillStyle = DisplayPaint.strokeStyle(0.08)
                                context.strokeStyle = DisplayPaint.strokeStyle(0.80)
                                context.stroke(path2D)
                            }
                            path2D.lineTo(x1, size)
                            path2D.lineTo(x0, size)
                            path2D.closePath()
                            context.fill(path2D)
                        }
                        drawPath(0, size, true)
                        const kneeValue = knee.getValue()
                        if (kneeValue > 0.0) {
                            const thresholdValue = threshold.getValue()
                            const x0 = (1.0 - scale.unitToNorm(-thresholdValue + kneeValue * 0.5)) * size
                            const x1 = (1.0 - scale.unitToNorm(-thresholdValue - kneeValue * 0.5)) * size
                            drawPath(Math.max(x0, 0), Math.min(x1, size), false)
                        }
                        const input = values[0]
                        const x = (1.0 - scale.unitToNorm(-input)) * size
                        const cp = computer.applyCompression(input) + input
                        const y = Math.min(scale.unitToNorm(-cp) * size, size)
                        context.beginPath()
                        context.arc(x, y, 3, 0.0, TAU)
                        context.fillStyle = "hsla(200, 83%, 60%, 0.80)"
                        context.fill()
                        context.restore()
                    }))
                    lifecycle.ownAll(
                        AnimationFrame.add(() => canvasPainter.requestUpdate()),
                        threshold.catchupAndSubscribe(owner => {
                            computer.setThreshold(owner.getValue())
                            canvasPainter.requestUpdate()
                        }),
                        ratio.catchupAndSubscribe(owner => {
                            computer.setRatio(owner.getValue())
                            canvasPainter.requestUpdate()
                        }),
                        knee.catchupAndSubscribe(owner => {
                            computer.setKnee(owner.getValue())
                            canvasPainter.requestUpdate()
                        })
                    )
                    return canvasPainter
                }}/>
        </div>
    )
}