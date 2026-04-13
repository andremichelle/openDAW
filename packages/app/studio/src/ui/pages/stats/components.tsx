import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Lifecycle, isDefined} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"

type CardProps = {
    title?: string
    accent?: JsxValue
    className?: string
}

export const Card = ({title, accent, className}: CardProps, children: ReadonlyArray<JsxValue>) => (
    <div className={`card${isDefined(className) ? ` ${className}` : ""}`}>
        {(isDefined(title) || isDefined(accent)) && (
            <div className="card-head">
                {isDefined(title) && <h2>{title}</h2>}
                {isDefined(accent) && <div className="card-accent">{accent}</div>}
            </div>
        )}
        <div className="card-body">{children}</div>
    </div>
)

type RangeControlProps = {
    lifecycle: Lifecycle
    dates: ReadonlyArray<string>
    range: DefaultObservableValue<readonly [number, number]>
}

export const RangeControl = ({lifecycle, dates, range}: RangeControlProps) => {
    const track: HTMLDivElement = <div className="range-track"/>
    const selection: HTMLDivElement = <div className="range-selection"/>
    const handleFrom: HTMLDivElement = <div className="range-handle from"/>
    const handleTo: HTMLDivElement = <div className="range-handle to"/>
    const labelFrom: HTMLSpanElement = <span className="range-label"/>
    const labelTo: HTMLSpanElement = <span className="range-label right"/>
    const indexToRatio = (index: number): number => dates.length <= 1 ? 0 : index / (dates.length - 1)
    const ratioToIndex = (ratio: number): number => {
        const clamped = Math.max(0, Math.min(1, ratio))
        return Math.round(clamped * Math.max(0, dates.length - 1))
    }
    const render = ([fromIndex, toIndex]: readonly [number, number]) => {
        const fromRatio = indexToRatio(fromIndex)
        const toRatio = indexToRatio(toIndex)
        selection.style.left = `${fromRatio * 100}%`
        selection.style.width = `${Math.max(0, (toRatio - fromRatio) * 100)}%`
        handleFrom.style.left = `${fromRatio * 100}%`
        handleTo.style.left = `${toRatio * 100}%`
        labelFrom.textContent = dates[fromIndex] ?? ""
        labelTo.textContent = dates[toIndex] ?? ""
    }
    lifecycle.own(range.catchupAndSubscribe(owner => render(owner.getValue())))
    const beginDrag = (which: "from" | "to" | "band") => (event: PointerEvent) => {
        event.preventDefault()
        const rect = track.getBoundingClientRect()
        const startRatio = (event.clientX - rect.left) / rect.width
        const [startFrom, startTo] = range.getValue()
        const startSpan = startTo - startFrom
        const onMove = (moveEvent: PointerEvent) => {
            const ratio = (moveEvent.clientX - rect.left) / rect.width
            if (which === "from") {
                const next = Math.min(ratioToIndex(ratio), startTo)
                range.setValue([next, startTo])
            } else if (which === "to") {
                const next = Math.max(ratioToIndex(ratio), startFrom)
                range.setValue([startFrom, next])
            } else {
                const delta = ratioToIndex(ratio) - ratioToIndex(startRatio)
                let nextFrom = startFrom + delta
                let nextTo = startTo + delta
                if (nextFrom < 0) {nextFrom = 0; nextTo = startSpan}
                if (nextTo > dates.length - 1) {nextTo = dates.length - 1; nextFrom = nextTo - startSpan}
                range.setValue([nextFrom, nextTo])
            }
        }
        const onUp = () => {
            window.removeEventListener("pointermove", onMove)
            window.removeEventListener("pointerup", onUp)
        }
        window.addEventListener("pointermove", onMove)
        window.addEventListener("pointerup", onUp)
    }
    lifecycle.own(Events.subscribe(handleFrom, "pointerdown", beginDrag("from")))
    lifecycle.own(Events.subscribe(handleTo, "pointerdown", beginDrag("to")))
    lifecycle.own(Events.subscribe(selection, "pointerdown", beginDrag("band")))
    return (
        <div className="range-control">
            <div className="range-labels">
                {labelFrom}
                {labelTo}
            </div>
            <div className="range-wrap">
                {track}
                {selection}
                {handleFrom}
                {handleTo}
            </div>
        </div>
    )
}
