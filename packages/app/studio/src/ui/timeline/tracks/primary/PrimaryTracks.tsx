import css from "./PrimaryTracks.sass?inline"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement, Frag, replaceChildren} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {MarkerTrack} from "./marker/MarkerTrack"
import {deferNextFrame, Html} from "@opendaw/lib-dom"
import {TempoTrack} from "@/ui/timeline/tracks/primary/tempo/TempoTrack"
import {SignatureTrack} from "@/ui/timeline/tracks/primary/signature/SignatureTrack"

const className = Html.adoptStyleSheet(css, "primary-tracks")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const PrimaryTracks = ({lifecycle, service}: Construct) => {
    const {timeline: {primaryVisibility: {markers, tempo, signature}}} = service
    const element: HTMLElement = (<div className={className}/>)
    const trackTerminator = lifecycle.own(new Terminator())
    const {request} = lifecycle.own(deferNextFrame(() => {
        trackTerminator.terminate()
        const isMarkerTrackVisible = markers.getValue()
        const isTempoTrackVisible = tempo.getValue()
        const isSignatureTrackVisible = signature.getValue()
        const anyPrimaryTrackVisible = isMarkerTrackVisible || isTempoTrackVisible || isSignatureTrackVisible
        element.classList.toggle("hidden", !anyPrimaryTrackVisible)
        if (anyPrimaryTrackVisible) {
            replaceChildren(element,
                <Frag>
                    {isMarkerTrackVisible && <MarkerTrack lifecycle={trackTerminator} service={service}/>}
                    {isSignatureTrackVisible && <SignatureTrack lifecycle={trackTerminator} service={service}/>}
                    {isTempoTrackVisible && <TempoTrack lifecycle={trackTerminator} service={service}/>}
                </Frag>
            )
        }
    }))
    lifecycle.ownAll(
        markers.catchupAndSubscribe(request),
        tempo.catchupAndSubscribe(request),
        signature.catchupAndSubscribe(request)
    )
    return element
}