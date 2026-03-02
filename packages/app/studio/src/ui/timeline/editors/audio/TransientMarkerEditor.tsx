import css from "./TransientMarkerEditor.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {BinarySearch, Lifecycle, Nullable, NumberComparator, ObservableValue, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {CanvasPainter, Project, TimelineRange} from "@opendaw/studio-core"
import {Snapping} from "@/ui/timeline/Snapping"
import {Colors} from "@opendaw/studio-enums"
import {WheelScaling} from "@/ui/timeline/WheelScaling"
import {TransientMarkerBoxAdapter} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "TransientMarkerEditor")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    range: TimelineRange
    snapping: Snapping
    reader: AudioEventOwnerReader
    hoverTransient: ObservableValue<Nullable<TransientMarkerBoxAdapter>>
}

export const TransientMarkerEditor = ({lifecycle, range, reader, hoverTransient}: Construct) => {
    const {audioContent} = reader
    return (
        <div className={className} onInit={element =>
            lifecycle.own(audioContent.observableOptPlayMode.catchupAndSubscribe(() =>
                element.classList.toggle("no-content", audioContent.asPlayModeTimeStretch.isEmpty())))}>
            <canvas onInit={canvas => {
                const {requestUpdate} = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {context, actualHeight, devicePixelRatio} = painter
                    const optWarpMarkers = audioContent.optWarpMarkers
                    if (optWarpMarkers.isEmpty() || audioContent.asPlayModeTimeStretch.isEmpty()) {return}
                    const transientsCollection = audioContent.file.transients
                    if (transientsCollection.length() < 2) {return}
                    const warpMarkers = optWarpMarkers.unwrap()
                    const waveformOffset = audioContent.waveformOffset.getValue()
                    const markers = warpMarkers.asArray()
                    if (markers.length < 2) {return}
                    const first = markers[0]
                    const second = markers[1]
                    const secondLast = markers[markers.length - 2]
                    const last = markers[markers.length - 1]
                    // Rates in ppqn per second (inverse of waveform's seconds per ppqn)
                    const firstRate = (second.position - first.position) / (second.seconds - first.seconds)
                    const lastRate = (last.position - secondLast.position) / (last.seconds - secondLast.seconds)
                    const secondsToLocalUnit = (seconds: number): number => {
                        if (seconds < first.seconds) {
                            return first.position + (seconds - first.seconds) * firstRate
                        }
                        if (seconds > last.seconds) {
                            return last.position + (seconds - last.seconds) * lastRate
                        }
                        const index = Math.min(markers.length - 2, BinarySearch.rightMostMapped(markers, seconds, NumberComparator, ({seconds}) => seconds))
                        const left = markers[index]
                        const right = markers[index + 1]
                        const t = (seconds - left.seconds) / (right.seconds - left.seconds)
                        return left.position + t * (right.position - left.position)
                    }
                    const localUnitToSeconds = (localUnit: number): number => {
                        if (localUnit < first.position) {
                            return first.seconds + (localUnit - first.position) / firstRate
                        }
                        if (localUnit > last.position) {
                            return last.seconds + (localUnit - last.position) / lastRate
                        }
                        const index = warpMarkers.floorLastIndex(localUnit)
                        const left = markers[index]
                        const right = markers[index + 1]
                        const t = (localUnit - left.position) / (right.position - left.position)
                        return left.seconds + t * (right.seconds - left.seconds)
                    }
                    const visibleStartSeconds = localUnitToSeconds(range.unitMin - range.unitPadding - reader.offset) + waveformOffset
                    const transients = transientsCollection.asArray()
                    const startIndex = Math.max(0, transientsCollection.floorLastIndex(visibleStartSeconds))
                    for (let i = startIndex; i < transients.length; i++) {
                        const transient = transients[i]
                        const adjustedSeconds = transient.position - waveformOffset
                        const localUnit = secondsToLocalUnit(adjustedSeconds)
                        const unit = reader.offset + localUnit
                        if (unit < range.unitMin - range.unitPadding) {continue}
                        if (unit > range.unitMax) {break}
                        const x = range.unitToX(unit) * devicePixelRatio
                        context.beginPath()
                        context.moveTo(x, actualHeight * 0.85)
                        context.lineTo(x - 7, actualHeight * 0.50)
                        context.lineTo(x + 7, actualHeight * 0.50)
                        context.fillStyle = hoverTransient.getValue() === transient
                            ? Colors.white.toString()
                            : Colors.shadow.toString()
                        context.fill()
                    }
                }))
                const playModeTerminator = lifecycle.own(new Terminator())
                lifecycle.ownAll(
                    WheelScaling.install(canvas, range),
                    range.subscribe(requestUpdate),
                    reader.subscribeChange(requestUpdate),
                    audioContent.observableOptPlayMode.catchupAndSubscribe((optPlayMode) => {
                        playModeTerminator.terminate()
                        optPlayMode.ifSome(playMode => playModeTerminator.ownAll(
                            playMode.subscribe(requestUpdate),
                            hoverTransient.subscribe(requestUpdate)
                        ))
                    })
                )
            }}/>
        </div>
    )
}