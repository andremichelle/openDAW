import css from "./SignatureTrackBody.sass?inline"
import {Lifecycle, Nullable} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {Signature, SignatureTrackAdapter, TimelineBoxAdapter} from "@opendaw/studio-adapters"
import {createElement} from "@opendaw/lib-jsx"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {SignatureRenderer} from "@/ui/timeline/tracks/primary/signature/SignatureRenderer"
import {SignatureContextMenu} from "@/ui/timeline/tracks/primary/signature/SignatureContextMenu"
import {Html} from "@opendaw/lib-dom"

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
    const {context, requestUpdate} = lifecycle.own(
        SignatureRenderer.createTrackRenderer(canvas, range, signatureTrackAdapter)
    )

    const findSignatureAtPosition = (ppqn: number): Nullable<Signature> => {
        let result: Nullable<Signature> = null
        for (const sig of signatureTrackAdapter.iterateAll()) {
            if (sig.accumulatedPpqn > ppqn) {break}
            result = sig
        }
        return result
    }

    const capturing = new ElementCapturing<Signature>(canvas, {
        capture: (localX: number, _localY: number): Nullable<Signature> => {
            const pointer = range.xToUnit(localX)
            const signature = findSignatureAtPosition(pointer)
            if (signature === null) {return null}
            const signatureWidth = SignatureRenderer.computeWidth(context, signature)
            return localX - range.unitToX(signature.accumulatedPpqn) < signatureWidth ? signature : null
        }
    })

    lifecycle.ownAll(
        range.subscribe(requestUpdate),
        signatureTrackAdapter.subscribe(requestUpdate),
        SignatureContextMenu.install(canvas, range, capturing, editing, signatureTrackAdapter)
    )
    return (<div className={className}>{canvas}</div>)
}
