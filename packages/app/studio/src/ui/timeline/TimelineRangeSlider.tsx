import css from "./TimelineRangeSlider.sass?inline"
import {int, Lifecycle, Option, Terminator, unitValue} from "@moises-ai/lib-std"
import {createElement, Frag} from "@moises-ai/lib-jsx"
import {ValueDragging} from "@/ui/hooks/dragging.ts"
import {TimelineRange} from "@moises-ai/studio-core"
import {Events, Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "TimelineRangeSlider")

type Construct = {
    lifecycle: Lifecycle
    range: TimelineRange
    style?: Partial<CSSStyleDeclaration>
    className?: string
}

const COLOR_HANDLER = "rgba(255,255,255,0.25)"
const COLOR_BACKGROUND = "rgba(255,255,255,0.125)"

export const TimelineRangeSlider = ({lifecycle, range, style, className: extraClassName}: Construct) => {
    const radius = 5
    const padding = radius * 2
    const markerParts: [SVGElement, SVGElement, SVGRectElement] = (
        <Frag>
            <path
                d={`M ${radius} 0h ${radius}v ${radius * 2}h -${radius}a ${radius} ${radius} 0 0 1 -${radius} -${radius}a ${radius} ${radius} 0 0 1 ${radius} -${radius}`}
                fill={COLOR_HANDLER}/>
            <path
                d={`M ${radius * 2} 0h ${radius}a ${radius} ${radius} 0 0 1 0 ${radius * 2}h ${-radius}v ${-radius * 2}`}
                fill={COLOR_HANDLER}/>
            <rect width="0" height={radius * 2} fill={COLOR_BACKGROUND}/>
        </Frag>
    )
    const slider: SVGSVGElement = (
        <svg classList="slider" viewBox="0 0 0 0" shape-rendering="geometricPrecision">{markerParts}</svg>
    )
    const dragLifeTime = lifecycle.own(new Terminator())
    const computeSize = () => {
        const {clientWidth, clientHeight} = slider
        return ({clientWidth, clientHeight, trackLength: clientWidth - padding * 2})
    }
    const onUpdate = () => {
        if (!slider.isConnected) {return}
        const {trackLength} = computeSize()
        const x0 = Math.floor(range.min * trackLength)
        const x1 = Math.floor(range.max * trackLength)
        markerParts[0].setAttribute("transform", `translate(${x0}, 0)`)
        markerParts[1].setAttribute("transform", `translate(${x1}, 0)`)
        markerParts[2].x.baseVal.value = x0 + padding
        markerParts[2].width.baseVal.value = x1 - x0
    }
    const onResize = () => {
        const {clientWidth, clientHeight, trackLength} = computeSize()
        if (clientWidth === 0 || clientHeight === 0) return
        slider.viewBox.baseVal.width = clientWidth
        slider.viewBox.baseVal.height = clientHeight
        dragLifeTime.terminate()
        dragLifeTime.own(ValueDragging.installUnitValueRelativeDragging((event: PointerEvent) =>
            Option.wrap(new class implements ValueDragging.Process {
                #partIndex: int = markerParts.indexOf(event.target as any)
                start(): unitValue {
                    switch (this.#partIndex) {
                        case 0:
                            return range.min
                        case 1:
                            return range.max
                        case 2:
                            return range.center
                        default:
                            const rect = slider.getBoundingClientRect()
                            return range.center = (event.clientX - rect.left - padding) / trackLength
                    }
                }
                modify(value: unitValue): void {
                    switch (this.#partIndex) {
                        case 0:
                            range.min = value
                            return
                        case 1:
                            range.max = value
                            return
                        default:
                            range.center = value
                            return
                    }
                }
                cancel(_prevValue: unitValue): void {}
                finalise(_prevValue: unitValue, _newValue: unitValue): void {}
                finally(): void {}
            }), slider, {horizontal: true, trackLength, ratio: 1.0}))
        onUpdate()
    }

    lifecycle.own(Html.watchResize(slider, onResize))
    lifecycle.own(range.subscribe(onUpdate))
    lifecycle.own(Events.subscribeDblDwn(slider, () => range.showAll()))
    return <div className={Html.buildClassList(className, extraClassName)} style={style}>{slider}</div>
}