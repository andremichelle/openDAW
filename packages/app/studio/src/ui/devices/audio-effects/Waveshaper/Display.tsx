import css from "./Display.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Arrays, Editing, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {dbToGain, Waveshaper} from "@opendaw/lib-dsp"
import {Colors} from "@opendaw/studio-enums"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {WaveshaperDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter} from "@opendaw/studio-core"
import {DropDown} from "@/ui/composite/DropDown.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"

const className = Html.adoptStyleSheet(css, "Display")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: WaveshaperDeviceBoxAdapter
}

export const Display = ({lifecycle, editing, adapter}: Construct) => {
    const {inputGain} = adapter.namedParameter
    const {equation} = adapter.box
    return (
        <div className={className}>
            <div className="equation-select">
                <DropDown lifecycle={lifecycle}
                          owner={EditWrapper.forValue(editing, equation)}
                          provider={() => Waveshaper.Equations}
                          appearance={{
                              framed: true, landscape: true,
                              color: Colors.dark,
                              activeColor: Colors.white
                          }}
                          mapping={value => value.toUpperCase()}
                          width="72px"/>
            </div>
            <canvas onInit={canvas => {
                const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {devicePixelRatio, context, actualWidth, actualHeight} = painter
                    const range = 1.5
                    const inputGainValue = dbToGain(inputGain.getControlledValue())
                    const equation = (adapter.box.equation.getValue()) as Waveshaper.Equation
                    const toX = (value: number) => ((value + range) / (2.0 * range)) * actualWidth
                    const toY = (value: number) => ((range - value) / (2.0 * range)) * actualHeight
                    context.save()
                    context.setLineDash([4, 4])
                    context.lineWidth = devicePixelRatio
                    context.beginPath()
                    context.moveTo(toX(0), 0)
                    context.lineTo(toX(0), actualHeight)
                    context.moveTo(0, toY(0))
                    context.lineTo(actualWidth, toY(0))
                    context.strokeStyle = DisplayPaint.strokeStyle(0.25)
                    context.stroke()
                    context.beginPath()
                    context.moveTo(toX(-range), toY(-range))
                    context.lineTo(toX(range), toY(range))
                    context.strokeStyle = DisplayPaint.strokeStyle(0.25)
                    context.stroke()
                    const steps = actualWidth
                    const zeroY = toY(0)
                    const path = new Path2D()
                    context.setLineDash(Arrays.empty())
                    path.moveTo(toX(-range), toY(Waveshaper.apply(-range * inputGainValue, equation)))
                    for (let px = 1; px <= steps; px++) {
                        const x = -range + (px / steps) * 2.0 * range
                        path.lineTo(toX(x), toY(Waveshaper.apply(x * inputGainValue, equation)))
                    }
                    context.strokeStyle = DisplayPaint.strokeStyle(0.75)
                    context.stroke(path)
                    path.lineTo(toX(range), zeroY)
                    path.lineTo(toX(-range), zeroY)
                    const gradient = context.createLinearGradient(0, toY(1), 0, toY(-1))
                    gradient.addColorStop(0, DisplayPaint.strokeStyle(0.0))
                    gradient.addColorStop(0.5, DisplayPaint.strokeStyle(0.12))
                    gradient.addColorStop(1, DisplayPaint.strokeStyle(0.0))
                    context.fillStyle = gradient
                    context.fill(path)
                    context.restore()
                }))
                lifecycle.ownAll(
                    inputGain.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.box.equation.catchupAndSubscribe(() => painter.requestUpdate())
                )
            }}/>
        </div>
    )
}