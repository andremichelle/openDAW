import css from "./SignatureTrackBody.sass?inline"
import {EmptyExec, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {ppqn} from "@opendaw/lib-dsp"
import {Parsing, SignatureEvent, SignatureTrackAdapter, TimelineBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {SignatureRenderer} from "@/ui/timeline/tracks/primary/signature/SignatureRenderer"
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
    const {range} = timeline
    const canvas: HTMLCanvasElement = <canvas style={{fontSize: "1.25em"}}/>
    const timelineAdapter = project.boxAdapters.adapterFor(project.timelineBox, TimelineBoxAdapter)
    const signatureTrackAdapter: SignatureTrackAdapter = timelineAdapter.signatureTrack
    const {context, requestUpdate} = lifecycle.own(SignatureRenderer.forTrack(canvas, range, signatureTrackAdapter))
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
        Events.subscribeDblDwn(canvas, event => {
            const localX = event.clientX - canvas.getBoundingClientRect().left
            const position = range.xToUnit(localX)
            const signature = findSignatureAtPosition(position)
            if (signature === null) {return}
            const resolvers = Promise.withResolvers<string>()
            const clientRect = canvas.getBoundingClientRect()
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