import css from "./TimeAxis.sass?inline"
import {clamp, EmptyExec, isDefined, Lifecycle, Nullable, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {CanvasPainter, TimeGrid, TimelineRange} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {Dragging, Html} from "@opendaw/lib-dom"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {WheelScaling} from "@/ui/timeline/WheelScaling"

const className = Html.adoptStyleSheet(css, "time-axis")

const MIN_TRACK_DURATION = 8 * PPQN.Bar
const MAX_TRACK_DURATION = 1024 * PPQN.Bar

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    snapping: Snapping
    range: TimelineRange
    mapper?: TimeAxisCursorMapper
}

export interface TimeAxisCursorMapper {
    mapPlaybackCursor(position: ppqn): ppqn
}

export const TimeAxis = ({lifecycle, service, snapping, range, mapper}: Construct) => {
    let endMarkerPosition: Nullable<ppqn> = null
    const {
        project: {
            timelineBox: {durationInPulses},
            timelineBoxAdapter: {signatureTrack},
            engine, editing
        }
    } = service
    const {position, playbackTimestamp} = engine
    const canvas: HTMLCanvasElement = (<canvas/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context}) => {
        const {height} = canvas
        const {fontFamily, fontSize} = getComputedStyle(canvas)
        context.fillStyle = Colors.shadow.toString()
        context.textBaseline = "alphabetic"
        context.font = `${parseFloat(fontSize) * devicePixelRatio}px ${fontFamily}`
        const textY = height - 4 * devicePixelRatio
        TimeGrid.fragment(signatureTrack,
            range, ({bars, beats, isBar, isBeat, pulse}) => {
                const x = Math.floor(range.unitToX(pulse)) * devicePixelRatio
                const textX = x + 5
                if (isBar) {
                    context.fillRect(x, 0, devicePixelRatio, height)
                    context.fillText((bars + 1).toFixed(0), textX, textY)
                } else if (isBeat) {
                    context.fillRect(x, height * 0.5, 1, height * 0.5)
                    context.fillRect(x, height * 0.5, 4, 1)
                    context.fillText((bars + 1) + "•" + (beats + 1), textX, textY)
                } else {
                    context.fillRect(x, height * 0.5, 1, height * 0.5)
                }
            })
        const pulse = engine.playbackTimestamp.getValue()
        const x = Math.floor(range.unitToX(pulse)) * devicePixelRatio
        context.fillStyle = "rgba(255, 255, 255, 0.25)"
        context.fillRect(x, 0, 1, height)
    }))
    const cursorElement: HTMLDivElement = <div className="cursor" data-component="cursor"/>
    const updateCursor = () => {
        const pulses = isDefined(mapper) ? mapper.mapPlaybackCursor(position.getValue()) : position.getValue()
        const x = Math.floor(range.unitToX(pulses))
        cursorElement.style.left = `${x}px`
        cursorElement.style.visibility = 0 < x && x < range.width ? "visible" : "hidden"
    }
    const endMarkerElement: HTMLDivElement = <div className="end-marker" data-component="end-marker"/>
    const updateEndMarker = () => {
        const pulses = endMarkerPosition ?? durationInPulses.getValue()
        endMarkerElement.style.left = `${Math.floor(range.unitToX(pulses))}px`
        endMarkerElement.style.visibility = range.unitMin <= pulses && pulses < range.unitMax ? "visible" : "hidden"
    }
    const onResize = () => {
        if (!canvas.isConnected) {return}
        range.width = canvas.clientWidth
        painter.requestUpdate()
        updateCursor()
        updateEndMarker()
    }
    lifecycle.ownAll(
        range.subscribe(updateCursor),
        range.subscribe(updateEndMarker),
        position.subscribe(updateCursor),
        durationInPulses.catchupAndSubscribe(() => updateEndMarker()),
        Dragging.attach(canvas, () => Option.wrap({
            update: (event: Dragging.Event) => {
                const x = event.clientX - canvas.getBoundingClientRect().left
                const p = Math.max(0, range.xToUnit(x))
                engine.setPosition(snapping.round(p))
                if (p < range.unitMin) {
                    range.moveToUnit(p)
                } else if (p > range.unitMax) {
                    range.moveToUnit(p - range.unitRange)
                }
            }
        }), {immediate: true, permanentUpdates: false}),
        TextTooltip.simple(endMarkerElement, () => {
            const rect = endMarkerElement.getBoundingClientRect()
            return ({
                text: "Double-click to edit",
                clientX: rect.left,
                clientY: rect.top + 24
            })
        }),
        WheelScaling.install(canvas, range),
        Html.watchResize(canvas, onResize),
        range.subscribe(painter.requestUpdate),
        playbackTimestamp.subscribe(painter.requestUpdate),
        signatureTrack.subscribe(painter.requestUpdate)
    )
    return (
        <div className={className} tabIndex={-1} onmousedown={event => event.preventDefault()}>
            {canvas}
            <DblClckTextInput resolversFactory={() => {
                const resolvers = Promise.withResolvers<string>()
                resolvers.promise.then((value: string) => {
                    const number = parseFloat(value)
                    if (isNaN(number)) {return}
                    editing.modify(() => durationInPulses.setValue(clamp((number - 1) * PPQN.Bar, MIN_TRACK_DURATION, MAX_TRACK_DURATION)))
                }, EmptyExec)
                return resolvers
            }} provider={() => ({
                unit: "bars",
                value: (signatureTrack.toParts(durationInPulses.getValue()).bars + 1).toString()
            })} location={() => {
                const rect = endMarkerElement.getBoundingClientRect()
                return {x: rect.left - 32, y: rect.top}
            }}>
                {endMarkerElement}
            </DblClckTextInput>
            {cursorElement}
        </div>
    )
}