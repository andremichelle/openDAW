import css from "./SignatureTrackBody.sass?inline"
import {Lifecycle, Nullable, Option} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {SignatureEventBoxAdapter, SignatureTrackAdapter, TimelineBoxAdapter} from "@opendaw/studio-adapters"
import {createElement} from "@opendaw/lib-jsx"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {SignatureEventBox} from "@opendaw/studio-boxes"
import {SignatureRenderer} from "@/ui/timeline/tracks/primary/signature/SignatureRenderer"
import {SignatureContextMenu} from "@/ui/timeline/tracks/primary/signature/SignatureContextMenu"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {UUID} from "@opendaw/lib-std"

const className = Html.adoptStyleSheet(css, "signature-track-body")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const SignatureTrackBody = ({lifecycle, service}: Construct) => {
    const {project, timeline} = service
    const {editing, boxGraph} = project
    const {range, snapping} = timeline
    const canvas: HTMLCanvasElement = <canvas style={{fontSize: "1.25em"}}/>
    const timelineAdapter = project.boxAdapters.adapterFor(project.timelineBox, TimelineBoxAdapter)
    const signatureTrackAdapter: SignatureTrackAdapter = timelineAdapter.signatureTrack
    const events = signatureTrackAdapter.events
    const {context, requestUpdate} = lifecycle.own(SignatureRenderer.createTrackRenderer(canvas, range, signatureTrackAdapter))
    const capturing = new ElementCapturing<SignatureEventBoxAdapter>(canvas, {
        capture: (localX: number, _localY: number): Nullable<SignatureEventBoxAdapter> => {
            const pointer = range.xToUnit(localX)
            const signature = events.lowerEqual(pointer)
            if (signature === null) {return null}
            const signatureWidth = SignatureRenderer.computeWidth(context, signature)
            return localX - range.unitToX(signature.position) < signatureWidth ? signature : null
        }
    })
    let lastTimeDown = 0
    lifecycle.ownAll(
        range.subscribe(requestUpdate),
        signatureTrackAdapter.subscribe(requestUpdate),
        SignatureContextMenu.install(canvas, range, capturing, editing),
        Dragging.attach(canvas, (startEvent: PointerEvent) => {
            const now = Date.now()
            const dblclck = now - lastTimeDown < Events.DOUBLE_DOWN_THRESHOLD
            lastTimeDown = now
            const adapter = capturing.captureEvent(startEvent)
            if (adapter === null) {
                if (dblclck) {
                    const rect = canvas.getBoundingClientRect()
                    const position = snapping.xToUnitFloor(startEvent.clientX - rect.left)
                    const lowerEqual = signatureTrackAdapter.events.lowerEqual(position)
                    if (lowerEqual?.position === position) {return Option.None}
                    editing.modify(() => SignatureEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(position)
                        box.nominator.setValue(4)
                        box.denominator.setValue(4)
                        box.events.refer(signatureTrackAdapter.object.events)
                    }))
                }
                return Option.None
            }
            const oldPosition = adapter.position
            return Option.wrap({
                update: (event: Dragging.Event) => {
                    const rect = canvas.getBoundingClientRect()
                    const position = snapping.xToUnitFloor(event.clientX - rect.left)
                    editing.modify(() => {
                        const atPosition = events.lowerEqual(position)
                        if (atPosition !== null && atPosition.position === position && atPosition !== adapter) {
                            atPosition.box.delete()
                        }
                        adapter.box.position.setValue(position)
                    }, false)
                },
                cancel: () => editing.modify(() => adapter.box.position.setValue(oldPosition)),
                approve: () => editing.mark()
            } satisfies Dragging.Process)
        })
    )
    return (<div className={className}>{canvas}</div>)
}
