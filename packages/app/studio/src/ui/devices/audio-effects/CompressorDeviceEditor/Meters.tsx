import css from "./Meters.sass?inline"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {clampUnit, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {LinearScale} from "@/ui/canvas/scale"
import {Colors} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "Meters")

type Construct = {
    lifecycle: Lifecycle
    values: Float32Array
}

export const Meters = ({lifecycle, values}: Construct) => {
    const scale = new LinearScale(0, 24)
    const width = 36
    const height = 157
    const padding = 10
    const innerHeight = height - padding * 2
    const meters: ReadonlyArray<SVGRectElement> = [
        <rect x="16" y="0" width="4" height={innerHeight * 2} fill={Colors.cream} rx="1" ry="1"/>,
        <rect x="23" y="0" width="4" height={innerHeight} fill={Colors.orange} rx="1" ry="1"/>,
        <rect x="30" y="0" width="4" height={innerHeight * 2 / 3} fill={Colors.cream} rx="1" ry="1"/>
    ]
    const setMeter = (meter: SVGRectElement, top: number, bottom: number) => {
        const min = Math.min(top, bottom)
        const max = Math.max(top, bottom)
        meter.y.baseVal.value = min
        meter.height.baseVal.value = max - min
    }
    lifecycle.own(AnimationFrame.add(() => {
        const [inputDb, reductionDb, outputDb] = values
        setMeter(meters[0], innerHeight, clampUnit(scale.unitToNorm(-inputDb)) * innerHeight)
        setMeter(meters[1], 0.0, clampUnit(scale.unitToNorm(-reductionDb)) * innerHeight)
        setMeter(meters[2], innerHeight, clampUnit(scale.unitToNorm(-outputDb)) * innerHeight)
    }))
    return (
        <svg classList={className} viewBox={`0 0 ${width} ${height}`} width={36} height={height}>
            <g transform={`translate(0, ${padding})`}>
                {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(db => (
                    <text x="0"
                          y={(scale.unitToNorm(db) * innerHeight).toString()}
                          font-size="8px"
                          fill="rgba(255, 255, 255, 0.25)"
                          alignment-baseline="middle">{db}</text>
                ))}
                <rect x="16" y="0" width="4" height={innerHeight} fill="rgba(0, 0, 0, 0.5)" rx="1" ry="1"/>
                <rect x="23" y="0" width="4" height={innerHeight} fill="rgba(0, 0, 0, 0.5)" rx="1" ry="1"/>
                <rect x="30" y="0" width="4" height={innerHeight} fill="rgba(0, 0, 0, 0.5)" rx="1" ry="1"/>
                {meters}
            </g>
        </svg>
    )
}