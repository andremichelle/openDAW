import css from "./SignatureTrackBody.sass?inline"
import {EmptyExec, Lifecycle, Nullable, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {ppqn} from "@opendaw/lib-dsp"
import {Parsing, SignatureEvent, SignatureEventBoxAdapter, SignatureTrackAdapter, TimelineBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ElementCapturing} from "../../../../../../../../studio/core/src/ui/canvas/capturing.ts"
import {SignatureDragPreview, SignatureRenderer} from "@/ui/timeline/tracks/primary/signature/SignatureRenderer"
import {SignatureContextMenu} from "@/ui/timeline/tracks/primary/signature/SignatureContextMenu"
import {Surface} from "@/ui/surface/Surface"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"

const className = Html.adoptStyleSheet(css, "signature-track-body")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const SignatureTrackBody = ({lifecycle, service}: Construct) => {
    const {project, timeline} = service
    const {editing} = project
    const {range, snapping} = timeline
    const canvas: HTMLCanvasElement = <canvas style={{fontSize: "1.25em"}}/>
    const timelineAdapter = project.boxAdapters.adapterFor(project.timelineBox, TimelineBoxAdapter)
    const signatureTrackAdapter: SignatureTrackAdapter = timelineAdapter.signatureTrack
    let dragPreview: Nullable<SignatureDragPreview> = null
    const {context, requestUpdate} = lifecycle.own(SignatureRenderer.forTrack(
        canvas, range, signatureTrackAdapter, () => dragPreview))
    const findSignatureAtPosition = (ppqn: ppqn): Nullable<SignatureEvent> => {
        let result: Nullable<SignatureEvent> = null
        for (const signature of signatureTrackAdapter.iterateAll()) {
            if (signature.accumulatedPpqn > ppqn) {break}
            result = signature
        }
        return result
    }
    const capturing = new ElementCapturing<SignatureEvent>(canvas, {
        capture: (localX: number, _localY: number): Nullable<SignatureEvent> => {
            const pointer = range.xToUnit(localX)
            const signature = findSignatureAtPosition(pointer)
            if (signature === null) {return null}
            const signatureWidth = SignatureRenderer.computeWidth(context, signature)
            return localX - range.unitToX(signature.accumulatedPpqn) < signatureWidth ? signature : null
        }
    })
    lifecycle.ownAll(
        Dragging.attach(canvas, (pointerEvent: PointerEvent): Option<Dragging.Process> => {
            const clientRect = canvas.getBoundingClientRect()
            const localX = pointerEvent.clientX - clientRect.left
            const event = capturing.captureLocalPoint(localX, 0)
            if (event === null || event.index === -1) {return Option.None}
            const adapter = signatureTrackAdapter.adapterAt(event.index)
            if (adapter.isEmpty()) {return Option.None}
            const signatureAdapter: SignatureEventBoxAdapter = adapter.unwrap()
            const pointerPpqn = range.xToUnit(localX)
            const offsetPpqn = pointerPpqn - event.accumulatedPpqn
            return Option.wrap({
                update: (dragEvent: Dragging.Event): void => {
                    const currentX = dragEvent.clientX - clientRect.left
                    const rawPpqn = range.xToUnit(currentX) - offsetPpqn
                    const targetPpqn = snapping.floor(Math.max(0, rawPpqn))
                    if (dragPreview === null || dragPreview.targetPpqn !== targetPpqn) {
                        dragPreview = {event, targetPpqn}
                        requestUpdate()
                    }
                },
                approve: (): void => {
                    if (dragPreview !== null && dragPreview.targetPpqn !== event.accumulatedPpqn) {
                        editing.modify(() => {
                            const targetPpqn = dragPreview!.targetPpqn
                            for (const sig of signatureTrackAdapter.iterateAll()) {
                                if (sig.index !== -1 && sig.index !== event.index && sig.accumulatedPpqn === targetPpqn) {
                                    const targetAdapter = signatureTrackAdapter.adapterAt(sig.index)
                                    if (targetAdapter.nonEmpty()) {
                                        signatureTrackAdapter.deleteAdapter(targetAdapter.unwrap())
                                    }
                                    break
                                }
                            }
                            signatureTrackAdapter.moveEvent(signatureAdapter, targetPpqn)
                        })
                    }
                    dragPreview = null
                    requestUpdate()
                },
                cancel: (): void => {
                    dragPreview = null
                    requestUpdate()
                }
            })
        }),
        Events.subscribeDblDwn(canvas, event => {
            const clientRect = canvas.getBoundingClientRect()
            const localX = event.clientX - clientRect.left
            const capturedEvent = capturing.captureLocalPoint(localX, 0)
            if (capturedEvent !== null) {
                if (capturedEvent.index === -1) {return}
                const adapter = signatureTrackAdapter.adapterAt(capturedEvent.index)
                if (adapter.nonEmpty()) {
                    editing.modify(() => signatureTrackAdapter.deleteAdapter(adapter.unwrap()))
                }
                return
            }
            const position = range.xToUnit(localX)
            const signature = findSignatureAtPosition(position)
            if (signature === null) {return}
            const resolvers = Promise.withResolvers<string>()
            Surface.get(canvas).flyout.appendChild(FloatingTextInput({
                position: {x: event.clientX, y: clientRect.top + clientRect.height / 2},
                value: `${signature.nominator}/${signature.denominator}`,
                resolvers
            }))
            resolvers.promise.then(value => {
                const attempt = Parsing.parseTimeSignature(value)
                if (attempt.isSuccess()) {
                    const [nominator, denominator] = attempt.result()
                    editing.modify(() => signatureTrackAdapter.createEvent(position, nominator, denominator))
                }
            }, EmptyExec)
        }),
        range.subscribe(requestUpdate),
        signatureTrackAdapter.subscribe(requestUpdate),
        SignatureContextMenu.install(canvas, range, capturing, editing, signatureTrackAdapter))
    return (<div className={className}>{canvas}</div>)
}