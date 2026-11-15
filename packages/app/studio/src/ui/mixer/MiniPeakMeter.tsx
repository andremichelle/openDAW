import css from "./MiniPeakMeter.sass?inline"
import {Arrays, Lifecycle, ValueMapping} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {meterRatio} from "@/ui/components/MeterRatio"

const className = Html.adoptStyleSheet(css, "MiniPeakMeter")

const Mapping = ValueMapping.linear(-60, 6)

type Construct = {
    lifecycle: Lifecycle
    peaks: Float32Array
}

export const MiniPeakMeter = ({lifecycle, peaks}: Construct) => {
    const bars: ReadonlyArray<HTMLElement> = Arrays.create(() => <div className="bar"/>, peaks.length)
    const element: HTMLElement = (
        <div className={className} style={{
            "--stop-yellow": `${Mapping.x(-18.0) * 100.0}%`,
            "--stop-red": `${Mapping.x(1.0) * 100.0}%`
        }}>
            {bars.map(bar => <div className="channel">{bar}</div>)}
        </div>
    )
    lifecycle.own(AnimationFrame.add(() => peaks.forEach((db, index) =>
        bars[index].style.setProperty("--level", String(meterRatio(Mapping, db))))))
    return element
}
