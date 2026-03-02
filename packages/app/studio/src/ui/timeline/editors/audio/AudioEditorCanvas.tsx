import css from "./AudioEditorCanvas.sass?inline"
import {isDefined, Lifecycle, Nullable, ObservableValue, Option, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AudioRenderer, CanvasPainter, Project, TimelineRange} from "@opendaw/studio-core"
import {EventCollection, LoopableRegion, ppqn} from "@opendaw/lib-dsp"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {renderTimeGrid} from "@/ui/timeline/editors/TimeGridRenderer.ts"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {installEditorBody} from "../EditorBody"
import {Dragging, Html} from "@opendaw/lib-dom"
import {WarpMarkerBoxAdapter} from "@opendaw/studio-adapters"
import {createAudioCapturing} from "@/ui/timeline/editors/audio/AudioCapturing"
import {installCursor} from "@/ui/hooks/cursor"
import {Cursor} from "@/ui/Cursors"

const className = Html.adoptStyleSheet(css, "AudioEditorCanvas")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    range: TimelineRange
    snapping: Snapping
    reader: AudioEventOwnerReader
    cursorModel: ObservableValue<Nullable<ppqn>>
}

export const AudioEditorCanvas = ({
                                      lifecycle,
                                      project: {editing, timelineBoxAdapter: {signatureTrack}},
                                      range,
                                      cursorModel,
                                      snapping,
                                      reader
                                  }: Construct) => {
    const {audioContent: {file, observableOptPlayMode, waveformOffset, gain}} = reader
    return (
        <div className={className}>
            <canvas tabIndex={-1} onInit={canvas => {
                const capturing = createAudioCapturing(canvas, range, reader)
                const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {context, actualHeight, devicePixelRatio} = painter
                    renderTimeGrid(context, signatureTrack, range, snapping, 0, actualHeight)
                    const x0 = Math.floor(range.unitToX(reader.offset) * devicePixelRatio)
                    const x1 = Math.floor(range.unitToX(reader.offset + reader.loopDuration) * devicePixelRatio)
                    if (x0 > 0) {
                        context.fillStyle = `hsla(${reader.hue}, 60%, 60%, 0.30)`
                        context.fillRect(x0, 0, devicePixelRatio, actualHeight)
                    }
                    if (x1 > 0) {
                        context.fillStyle = `hsla(${reader.hue}, 60%, 60%, 0.03)`
                        context.fillRect(x0, 0, x1 - x0, actualHeight)
                        context.fillStyle = `hsla(${reader.hue}, 60%, 60%, 0.30)`
                        context.fillRect(x1, 0, devicePixelRatio, actualHeight)
                    }

                    const pass = LoopableRegion.locateLoop(reader, range.unitMin - range.unitPadding, range.unitMax)
                    if (pass.isEmpty()) {return}
                    const tempoMap = reader.trackBoxAdapter.unwrap().context.tempoMap
                    AudioRenderer.render(context, range, file, tempoMap, observableOptPlayMode, waveformOffset.getValue(),
                        gain.getValue(), {top: 0, bottom: actualHeight},
                        `hsl(${reader.hue}, ${60}%, 45%)`, pass.unwrap(), false)

                    const cursor = cursorModel.getValue()
                    if (isDefined(cursor)) {
                        const x = Math.floor(range.unitToX(cursor + reader.offset) * devicePixelRatio)
                        context.fillStyle = `rgba(255, 255, 255, 0.5)`
                        context.fillRect(x, 0, devicePixelRatio, actualHeight)
                    }
                }))
                const playModeTerminator = lifecycle.own(new Terminator())
                const unitToSeconds = (ppqn: number, warpMarkers: EventCollection<WarpMarkerBoxAdapter>): number => {
                    const first = warpMarkers.first()
                    const last = warpMarkers.last()
                    if (first === null || last === null) {return 0.0}
                    // Before the first marker: extrapolate backwards
                    if (ppqn < first.position) {
                        const second = warpMarkers.greaterEqual(first.position + 1)
                        if (second === null) {return first.seconds}
                        const rate = (second.seconds - first.seconds) / (second.position - first.position)
                        return first.seconds + (ppqn - first.position) * rate
                    }
                    // After last marker: extrapolate forwards
                    if (ppqn > last.position) {
                        const secondLast = warpMarkers.lowerEqual(last.position - 1)
                        if (secondLast === null) {return last.seconds}
                        const rate = (last.seconds - secondLast.seconds) / (last.position - secondLast.position)
                        return last.seconds + (ppqn - last.position) * rate
                    }
                    // Within range: find bracketing markers directly
                    const w0 = warpMarkers.lowerEqual(ppqn)
                    const w1 = warpMarkers.greaterEqual(ppqn)
                    if (w0 === null || w1 === null) {return last.seconds}
                    if (w0.position === w1.position) {return w0.seconds}
                    const t = (ppqn - w0.position) / (w1.position - w0.position)
                    return w0.seconds + t * (w1.seconds - w0.seconds)
                }
                lifecycle.ownAll(
                    installEditorBody({element: canvas, range, reader}),
                    installCursor(canvas, capturing, {
                        get: (target) =>
                            target?.type === "loop-duration" && target?.reader.audioContent.canResize
                                ? Cursor.ExpandWidth : null
                    }),
                    cursorModel.subscribe(painter.requestUpdate),
                    reader.subscribeChange(painter.requestUpdate),
                    observableOptPlayMode.catchupAndSubscribe((optPlayMode) => {
                        playModeTerminator.terminate()
                        optPlayMode.ifSome(playMode => playModeTerminator.own(playMode.subscribe(painter.requestUpdate)))
                    }),
                    range.subscribe(painter.requestUpdate),
                    Dragging.attach(canvas, event => {
                        const target = capturing.captureEvent(event)
                        if (target?.type !== "loop-duration") {return Option.None}
                        if (!reader.audioContent.canResize) return Option.None
                        const startPPQN = range.xToUnit(event.clientX)
                        const beginPPQN = reader.loopDuration
                        return Option.wrap({
                            update: (event: Dragging.Event) => {
                                const delta = snapping.computeDelta(startPPQN, event.clientX, beginPPQN)
                                editing.modify(() => reader.contentDuration = beginPPQN + delta)
                            },
                            approve: () => editing.mark()
                        })
                    }, {permanentUpdates: true}),
                    Dragging.attach(canvas, startEvent => {
                        const rect = canvas.getBoundingClientRect()
                        const startX = startEvent.clientX - rect.left
                        const startOffset = waveformOffset.getValue()
                        const startPPQN = range.xToUnit(startX) - reader.offset
                        const optWarping = observableOptPlayMode.map(optPlayMode => optPlayMode.warpMarkers)
                        const startAudioSeconds = optWarping.match({
                            none: () => {
                                // NoSync: linear mapping based on loop duration ratio
                                const audioDuration = file.endInSeconds - file.startInSeconds
                                const ratio = audioDuration / reader.loopDuration
                                return startPPQN * ratio + startOffset
                            },
                            some: (warpMarkers) => unitToSeconds(startPPQN, warpMarkers) + startOffset
                        })
                        return Option.wrap({
                            update: (event: Dragging.Event) => {
                                const currentX = event.clientX - rect.left
                                const currentPPQN = range.xToUnit(currentX) - reader.offset
                                const currentAudioSecondsWithoutOffset = optWarping.match({
                                    none: () => {
                                        const audioDuration = file.endInSeconds - file.startInSeconds
                                        const ratio = audioDuration / reader.loopDuration
                                        return currentPPQN * ratio
                                    },
                                    some: (warpMarkers) => unitToSeconds(currentPPQN, warpMarkers)
                                })
                                const newOffset = startAudioSeconds - currentAudioSecondsWithoutOffset
                                editing.modify(() => waveformOffset.setValue(newOffset), false)
                            },
                            approve: () => editing.mark()
                        })
                    })
                )
            }}/>
        </div>
    )
}