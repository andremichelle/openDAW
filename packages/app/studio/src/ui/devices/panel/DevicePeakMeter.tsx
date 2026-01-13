import css from "./DevicePeakMeter.sass?inline"
import {Arrays, int, Lifecycle, Terminator, ValueMapping} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Address} from "@moises-ai/lib-box"
import {gainToDb} from "@moises-ai/lib-dsp"
import {LiveStreamReceiver} from "@moises-ai/lib-fusion"
import {Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "DevicePeakMeter")

type Construct = {
    lifecycle: Lifecycle
    receiver: LiveStreamReceiver
    address: Address
}

export const DevicePeakMeter = ({lifecycle, receiver, address}: Construct) => {
    const element: HTMLDivElement = (<div className={className}/>)
    const peaks = new Float32Array(2)
    const numChannels = 2
    const gradientID = Html.nextID()
    const animation = lifecycle.own(new Terminator())
    lifecycle.own(Html.watchResize(element, () => {
        if (!element.isConnected) {return}
        Html.empty(element)
        const barWidth = 2
        const barPadding = 1
        const mapping = ValueMapping.linear(-60, 6)
        const s0 = `${mapping.x(-18)}`
        const s1 = `${mapping.x(0)}`
        const width = numChannels * barWidth + (numChannels + 1) * barPadding
        const height = element.clientHeight
        const innerHeight = height - barPadding * 2
        const bars: Array<SVGRectElement> = Arrays.create(channelIndex => {
            const x = barPadding + (barWidth + barPadding) * channelIndex
            return <rect x={x}
                         y={barPadding}
                         width={barWidth}
                         height={0}
                         rx="1"
                         ry="1"
                         fill={`url(#${gradientID})`}/>
        }, numChannels)
        element.appendChild(
            <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
                <defs>
                    <linearGradient id={gradientID}
                                    x1="0" x2="0"
                                    y2={barPadding} y1={innerHeight}
                                    gradientUnits="userSpaceOnUse">
                        <stop offset={s0} stop-color={Colors.green}/>
                        <stop offset={s0} stop-color={Colors.yellow}/>
                        <stop offset={s1} stop-color={Colors.yellow}/>
                        <stop offset={s1} stop-color={Colors.red}/>
                    </linearGradient>
                </defs>
                {bars}
            </svg>
        )
        animation.terminate()
        animation.own(receiver.subscribeFloats(address, values => {
            peaks[0] = gainToDb(values[0])
            peaks[1] = gainToDb(values[1])
            peaks.forEach((db: number, index: int) => {
                const bar = bars[index]
                const ratio = db === Number.NEGATIVE_INFINITY ? 0.0 : mapping.x(db)
                const barHeight = Math.ceil(innerHeight * ratio)
                bar.y.baseVal.value = barPadding + (innerHeight - barHeight)
                bar.height.baseVal.value = barHeight
            })
        }))
    }))
    return element
}