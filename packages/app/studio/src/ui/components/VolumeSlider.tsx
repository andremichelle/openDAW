import css from "./VolumeSlider.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {
    clampUnit,
    EmptyExec,
    Lifecycle,
    Nullable,
    Option,
    Parameter,
    Strings,
    Terminator,
    unitValue
} from "@opendaw/lib-std"
import {ValueDragging} from "@/ui/hooks/dragging.ts"
import {ValueTooltip} from "@/ui/surface/ValueTooltip.tsx"
import {BoxEditing} from "@opendaw/lib-box"
import {CssUtils, Events, Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"
import {StudioPreferences} from "@opendaw/studio-core"
import {Runtime} from "@opendaw/lib-runtime"

const className = Html.adoptStyleSheet(css, "vertical-slider")

export const enum MarkerLength {Short, Long}

export type VolumeMarker = { length: MarkerLength, decibel: number }

export const DefaultVolumeMarkers: ReadonlyArray<VolumeMarker> = [
    {length: MarkerLength.Long, decibel: +6.0},
    {length: MarkerLength.Short, decibel: +5.0},
    {length: MarkerLength.Short, decibel: +4.0},
    {length: MarkerLength.Long, decibel: +3.0},
    {length: MarkerLength.Short, decibel: +2.0},
    {length: MarkerLength.Short, decibel: +1.0},
    {length: MarkerLength.Long, decibel: +0.0},
    {length: MarkerLength.Short, decibel: -1.0},
    {length: MarkerLength.Short, decibel: -2.0},
    {length: MarkerLength.Long, decibel: -3.0},
    {length: MarkerLength.Short, decibel: -4.0},
    {length: MarkerLength.Short, decibel: -5.0},
    {length: MarkerLength.Long, decibel: -6.0},
    {length: MarkerLength.Short, decibel: -7.0},
    {length: MarkerLength.Short, decibel: -8.0},
    {length: MarkerLength.Short, decibel: -9.0},
    {length: MarkerLength.Long, decibel: -10.0},
    {length: MarkerLength.Short, decibel: -11.25},
    {length: MarkerLength.Short, decibel: -12.5},
    {length: MarkerLength.Short, decibel: -13.5},
    {length: MarkerLength.Long, decibel: -15.0},
    {length: MarkerLength.Short, decibel: -16.5},
    {length: MarkerLength.Short, decibel: -17.75},
    {length: MarkerLength.Short, decibel: -19.5},
    {length: MarkerLength.Long, decibel: -21.0},
    {length: MarkerLength.Short, decibel: -23.0},
    {length: MarkerLength.Short, decibel: -25.5},
    {length: MarkerLength.Short, decibel: -28.0},
    {length: MarkerLength.Long, decibel: -30.0},
    {length: MarkerLength.Short, decibel: -34.0},
    {length: MarkerLength.Short, decibel: -39.0},
    {length: MarkerLength.Short, decibel: -44.0},
    {length: MarkerLength.Long, decibel: -50.0},
    {length: MarkerLength.Short, decibel: -56.0},
    {length: MarkerLength.Short, decibel: -63.0},
    {length: MarkerLength.Short, decibel: -72.0},
    {length: MarkerLength.Short, decibel: -84.0},
    {length: MarkerLength.Long, decibel: -96.0}
] as const

export const MaximizerVolumeMarkers: ReadonlyArray<VolumeMarker> = [
    {length: MarkerLength.Long, decibel: +3.0},
    {length: MarkerLength.Short, decibel: +2.0},
    {length: MarkerLength.Short, decibel: +1.0},
    {length: MarkerLength.Long, decibel: +0.0},
    {length: MarkerLength.Short, decibel: -1.0},
    {length: MarkerLength.Short, decibel: -2.0},
    {length: MarkerLength.Long, decibel: -3.0},
    {length: MarkerLength.Short, decibel: -4.0},
    {length: MarkerLength.Short, decibel: -5.0},
    {length: MarkerLength.Long, decibel: -6.0},
    {length: MarkerLength.Short, decibel: -7.0},
    {length: MarkerLength.Short, decibel: -8.0},
    {length: MarkerLength.Long, decibel: -9.0},
    {length: MarkerLength.Short, decibel: -10.0},
    {length: MarkerLength.Short, decibel: -11.0},
    {length: MarkerLength.Long, decibel: -12.0},
    {length: MarkerLength.Short, decibel: -13.0},
    {length: MarkerLength.Short, decibel: -14.0},
    {length: MarkerLength.Long, decibel: -15.0},
    {length: MarkerLength.Short, decibel: -16.0},
    {length: MarkerLength.Short, decibel: -17.0},
    {length: MarkerLength.Long, decibel: -18.0},
    {length: MarkerLength.Short, decibel: -19.0},
    {length: MarkerLength.Short, decibel: -20.0},
    {length: MarkerLength.Long, decibel: -21.0},
    {length: MarkerLength.Short, decibel: -22.0},
    {length: MarkerLength.Short, decibel: -23.0},
    {length: MarkerLength.Long, decibel: -24.0}
] as const

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    parameter: Parameter<number>
    markers?: ReadonlyArray<VolumeMarker>
}

export const VolumeSlider = ({lifecycle, editing, parameter, markers = DefaultVolumeMarkers}: Construct) => {
    const strokeWidth = 1.0 / devicePixelRatio
    const guide: SVGRectElement = (
        <rect width="0.125em"
              rx="0.0625em"
              ry="0.0625em"
              stroke="none"
              fill="rgba(0, 0, 0, 0.25)"/>
    )

    const linesLeft: ReadonlyArray<SVGLineElement> = markers.map(({length, decibel}) => {
        const y = `${(1.0 - parameter.valueMapping.x(decibel)) * 100.0}%`
        return <line x1={length === MarkerLength.Long ? 0 : "25%"}
                     y1={y}
                     y2={y}
                     stroke={decibel === 0 && Colors.green}/>
    })
    const linesRight: ReadonlyArray<SVGLineElement> = markers.map(({decibel}) => {
        const y = `${(1.0 - parameter.valueMapping.x(decibel)) * 100.0}%`
        return <line x1="50%"
                     y1={y}
                     y2={y}
                     stroke={decibel === 0 && Colors.green}/>
    })
    const lineContainer: SVGSVGElement = <svg y="1em"
                                              overflow="visible"
                                              stroke="rgba(255,255,255,0.16)"
                                              shape-rendering="crispEdges">{linesLeft}{linesRight}</svg>
    const svg: SVGSVGElement = (<svg viewBox="0 0 0 0">{guide}{lineContainer}</svg>)
    const thumb: HTMLElement = (<div className="thumb"/>)
    const wrapper: HTMLDivElement = (<div className={className} data-class="vertical-slider">{svg}{thumb}</div>)
    const dragLifecycle = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        Html.watchResize(wrapper, () => {
            if (!wrapper.isConnected) {return}
            lineContainer.setAttribute("stroke-width", String(strokeWidth))
            const {baseVal: rect} = svg.viewBox
            const {clientWidth, clientHeight} = wrapper
            rect.width = clientWidth
            rect.height = clientHeight
            const em = parseFloat(getComputedStyle(wrapper).fontSize)
            guide.x.baseVal.value = CssUtils.calc("50% - 0.0625em", clientWidth, em)
            guide.y.baseVal.value = CssUtils.calc("1em - 1px", clientHeight, em)
            guide.height.baseVal.value = CssUtils.calc("100% - 2em + 1.5px", clientHeight, em)
            const leftX2 = CssUtils.calc("50% - 0.0625em - 1px", clientWidth, em)
            const rightX1 = CssUtils.calc("50% + 0.0625em + 1px", clientWidth, em)
            linesLeft.forEach(line => {line.x2.baseVal.value = leftX2})
            linesRight.forEach((line, index) => {
                line.x1.baseVal.value = rightX1
                line.x2.baseVal.value = markers[index].length === MarkerLength.Long
                    ? clientWidth
                    : CssUtils.calc("75%", clientWidth, em)
            })
            lineContainer.height.baseVal.value = CssUtils.calc("100% - 2em", clientHeight, em)

            // attach a new dragging function with updated options
            //
            const snapLength = 8
            const guideBounds = guide.getBoundingClientRect()
            const trackLength = guideBounds.height
            dragLifecycle.terminate()
            dragLifecycle.own(ValueDragging.installUnitValueRelativeDragging((event: PointerEvent) => Option.wrap({
                start: (): unitValue => {
                    if (event.target === thumb) {
                        return parameter.getUnitValue()
                    } else {
                        const newValue: unitValue = 1.0 - (event.clientY - guideBounds.top) / guideBounds.height
                        editing.modify(() => parameter.setUnitValue(newValue), false)
                        return newValue
                    }
                },
                modify: (value: unitValue) => editing.modify(() => parameter.setUnitValue(value), false),
                cancel: (prevValue: unitValue) => editing.modify(() => parameter.setUnitValue(prevValue), false),
                finalise: (_prevValue: unitValue, _newValue: unitValue): void => editing.mark(),
                finally: (): void => {}
            }), wrapper, {
                trackLength: trackLength - snapLength,
                snap: {snapLength, threshold: parameter.valueMapping.x(0.0)},
                ratio: 1.0
            }))
        }))
    const observer = (parameter: Parameter<number>) =>
        wrapper.style.setProperty("--value", parameter.getControlledUnitValue().toString())
    lifecycle.ownAll(
        parameter.subscribe(observer),
        ValueTooltip.default(wrapper, () => {
            const clientRect = thumb.getBoundingClientRect()
            return ({
                clientX: clientRect.left + clientRect.width + 8,
                clientY: clientRect.top + clientRect.height + 8,
                ...parameter.getPrintValue()
            })
        }),
        Events.subscribeDblDwn(thumb, () => {
            const rect = thumb.getBoundingClientRect()
            const printValue = parameter.getPrintValue()
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then(value => {
                const withUnit = Strings.endsWithDigit(value) ? `${value}${printValue.unit}` : value
                editing.modify(() => parameter.setPrintValue(withUnit))
                editing.mark()
            }, EmptyExec)
            Surface.get(thumb).flyout.appendChild(
                <FloatingTextInput position={{x: rect.left, y: rect.top + (rect.height >> 1)}}
                                   value={printValue.value}
                                   unit={printValue.unit}
                                   numeric
                                   resolvers={resolvers}/>
            )
        }),
        StudioPreferences.catchupAndSubscribe((() => {
            const terminator = lifecycle.own(new Terminator())
            return (enabled) => {
                terminator.terminate()
                if (enabled) {
                    let value: Nullable<unitValue> = null
                    terminator.own(Events.subscribe(wrapper, "wheel", event => {
                        if (value === null) {
                            value = parameter.getUnitValue()
                        }
                        const ratio = 0.005
                        value = clampUnit(value - Math.sign(event.deltaY) * ratio)
                        editing.modify(() => parameter.setUnitValue(value!), false)
                        Runtime.debounce(() => {
                            value = null
                            editing.mark()
                        })
                        event.preventDefault()
                        event.stopImmediatePropagation()
                    }))
                }
            }
        })(), "modifying-controls-wheel")
    )
    observer(parameter)
    return wrapper
}