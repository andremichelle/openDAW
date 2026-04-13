import css from "./TrafficWatch.sass?inline"
import {isDefined, Lifecycle, Nullable} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {TrafficMeter} from "@opendaw/studio-p2p"

const className = Html.adoptStyleSheet(css, "traffic-watch")

const formatRate = (bytesPerSec: number): string => {
    if (bytesPerSec >= 1_048_576) {return `${(bytesPerSec / 1_048_576).toFixed(1)} MB/s`}
    if (bytesPerSec >= 1024) {return `${(bytesPerSec / 1024).toFixed(0)} KB/s`}
    return `${bytesPerSec.toFixed(0)} B/s`
}

type Construct = {
    lifecycle: Lifecycle
    trafficMeter: Nullable<TrafficMeter>
}

export const TrafficWatch = ({lifecycle, trafficMeter}: Construct) => {
    const upLabel: HTMLSpanElement = <span className="up"/>
    const downLabel: HTMLSpanElement = <span className="down"/>
    const element: HTMLElement = <div className={className}>{upLabel}{downLabel}</div>
    element.classList.add("hidden")
    const update = (meter: TrafficMeter) => {
        const up = meter.uploadRate
        const down = meter.downloadRate
        if (up === 0 && down === 0) {
            element.classList.add("hidden")
            return
        }
        element.classList.remove("hidden")
        upLabel.textContent = up > 0 ? `↑ ${formatRate(up)}` : ""
        downLabel.textContent = down > 0 ? `↓ ${formatRate(down)}` : ""
    }
    if (isDefined(trafficMeter)) {
        lifecycle.own(trafficMeter.subscribe(update))
    }
    return element
}
