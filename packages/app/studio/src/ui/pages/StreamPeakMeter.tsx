import css from "./StreamPeakMeter.sass?inline"
import {Arrays, int, Lifecycle, Terminator, ValueMapping} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {AnimationFrame, Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "StreamPeakMeter")

type Construct = {
    lifecycle: Lifecycle
    peaks: Float32Array
}

export const StreamPeakMeter = ({lifecycle, peaks}: Construct) => {
    const element: HTMLDivElement = (<div className={className}/>)
    const numChannels = peaks.length
    const gradientID = Html.nextID()
    const animation = lifecycle.own(new Terminator())
    lifecycle.own(Html.watchResize(element, () => {
        if (!element.isConnected) {return}
        Html.empty(element)
        const barHeight = 2
        const barPadding = 1
        const mapping = ValueMapping.linear(-48, 6)
        const s0 = `${mapping.x(-18)}`
        const s1 = `${mapping.x(0)}`
        const width = element.clientWidth
        const height = numChannels * barHeight + (numChannels + 1) * barPadding
        const innerWidth = width - barPadding * 2
        const bars: Array<SVGRectElement> = Arrays.create(channelIndex => {
            const y = barPadding + (barHeight + barPadding) * channelIndex
            return (
                <rect x={barPadding}
                      y={y}
                      width={0}
                      height={barHeight}
                      rx="1"
                      ry="1"
                      fill={`url(#${gradientID})`}/>
            )
        }, numChannels)
        element.appendChild(
            <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
                <defs>
                    <linearGradient id={gradientID}
                                    x1={barPadding} x2={innerWidth}
                                    y1="0" y2="0"
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
        animation.own(AnimationFrame.add(() => {
            peaks.forEach((db: number, index: int) => {
                const bar = bars[index]
                const ratio = db === Number.NEGATIVE_INFINITY ? 0.0 : mapping.x(db)
                const barWidth = Math.ceil(innerWidth * ratio)
                bar.x.baseVal.value = barPadding
                bar.width.baseVal.value = barWidth
            })
        }))
    }))
    return element
}