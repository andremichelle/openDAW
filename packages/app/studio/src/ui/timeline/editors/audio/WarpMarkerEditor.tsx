import css from "./WarpMarkerEditor.sass?inline"
import {Events, Html} from "@opendaw/lib-dom"
import {isDefined, isNull, Lifecycle, MutableObservableValue, Nullable, TAU, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {CanvasPainter, Project, TimelineRange} from "@opendaw/studio-core"
import {Snapping} from "@/ui/timeline/Snapping"
import {AudioPlayMode, AudioTimeStretchBoxAdapter, TransientMarkerBoxAdapter} from "@opendaw/studio-adapters"
import {WheelScaling} from "@/ui/timeline/WheelScaling"
import {WarpMarkerEditing} from "@/ui/timeline/editors/audio/WarpMarkerEditing"
import {TransientMarkerUtils} from "@/ui/timeline/editors/audio/TransientMarkerUtils"
import {ppqn} from "@opendaw/lib-dsp"
import {WarpMarkerUtils} from "@/ui/timeline/editors/audio/WarpMarkerUtils"
import {Surface} from "@/ui/surface/Surface"

const className = Html.adoptStyleSheet(css, "AudioWrapMarkers")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    range: TimelineRange
    snapping: Snapping
    reader: AudioEventOwnerReader
    hoverTransient: MutableObservableValue<Nullable<TransientMarkerBoxAdapter>>
    cursorModel: MutableObservableValue<Nullable<ppqn>>
}

export const WarpMarkerEditor = ({
                                     lifecycle, project, range, snapping, reader, hoverTransient, cursorModel
                                 }: Construct) => {
    const {audioContent} = reader
    const {file, observableOptPlayMode} = audioContent
    const markerRadius = 7
    return (
        <div className={className} onInit={element =>
            lifecycle.own(observableOptPlayMode.catchupAndSubscribe(() =>
                element.classList.toggle("no-content", audioContent.isPlayModeNoStretch)))}>
            <canvas tabIndex={-1}
                    onInit={canvas => {
                        const {requestUpdate} = lifecycle.own(new CanvasPainter(canvas, painter => {
                            const {context, actualHeight, devicePixelRatio} = painter
                            if (observableOptPlayMode.isEmpty()) {return}
                            if (audioContent.isPlayModeNoStretch) {return}
                            const warpMarkers = observableOptPlayMode.unwrap().warpMarkers
                            for (const marker of warpMarkers.iterateFrom(range.unitMin - reader.offset)) {
                                const unit = reader.offset + marker.position
                                if (unit > range.unitMax) {break}
                                const x = range.unitToX(unit) * devicePixelRatio
                                context.beginPath()
                                context.arc(x, actualHeight * 0.5, markerRadius, 0.0, TAU)
                                context.fillStyle = marker.isSelected
                                    ? `hsl(${reader.hue}, 60%, 80%)`
                                    : `hsl(${reader.hue}, 60%, 50%)`
                                context.fill()
                            }
                        }))
                        const audioPlayModeLifeCycle = lifecycle.own(new Terminator())
                        lifecycle.ownAll(
                            WheelScaling.install(canvas, range),
                            range.subscribe(requestUpdate),
                            reader.subscribeChange(requestUpdate),
                            observableOptPlayMode.catchupAndSubscribe((optPlayMode) => {
                                audioPlayModeLifeCycle.terminate()
                                optPlayMode.ifSome((audioPlayMode: AudioPlayMode) => {
                                    audioPlayModeLifeCycle.ownAll(
                                        audioPlayMode.subscribe(requestUpdate),
                                        WarpMarkerEditing.install(
                                            project, canvas, range, snapping, reader, audioPlayMode, hoverTransient))

                                    if (audioPlayMode instanceof AudioTimeStretchBoxAdapter) {
                                        const warpMarkers = audioPlayMode.warpMarkers
                                        const transientCapturing = TransientMarkerUtils.createCapturing(
                                            canvas, range, reader, warpMarkers, file.transients)
                                        const updatePreview = (noSnapping: boolean) => {
                                            const point = Surface.get(canvas).pointer
                                            const target = transientCapturing.captureEvent({
                                                clientX: point.x,
                                                clientY: point.y
                                            })
                                            hoverTransient.setValue(target)
                                            let local: ppqn
                                            if (isDefined(target) && !noSnapping) {
                                                local = TransientMarkerUtils.secondsToUnits(target.position, warpMarkers)
                                            } else {
                                                const x = point.x - canvas.getBoundingClientRect().left
                                                local = noSnapping ? range.xToUnit(x) - reader.offset : snapping.xToUnitRound(x) - reader.offset
                                            }
                                            const adjacentWarpMarkers = WarpMarkerUtils
                                                .findAdjacent(local, warpMarkers, true)
                                            const [left, right] = adjacentWarpMarkers
                                            if (isNull(left) || isNull(right)) {
                                                cursorModel.setValue(null)
                                                return
                                            }
                                            if (local - left.position < WarpMarkerEditing.MIN_DISTANCE
                                                || right.position - local < WarpMarkerEditing.MIN_DISTANCE) {
                                                cursorModel.setValue(null)
                                                return
                                            }
                                            cursorModel.setValue(local)
                                        }
                                        audioPlayModeLifeCycle.ownAll(
                                            Events.subscribe(canvas, "pointermove",
                                                event => {
                                                    if (event.buttons !== 0) {return}
                                                    updatePreview(event.shiftKey)
                                                }),
                                            Events.subscribe(canvas, "pointerout",
                                                () => {
                                                    cursorModel.setValue(null)
                                                    hoverTransient.setValue(null)
                                                }),
                                            Events.subscribe(canvas, "keydown",
                                                event => updatePreview(event.shiftKey)),
                                            Events.subscribe(canvas, "keyup",
                                                event => updatePreview(event.shiftKey))
                                        )
                                    }
                                })
                            }))
                    }}/>
        </div>
    )
}