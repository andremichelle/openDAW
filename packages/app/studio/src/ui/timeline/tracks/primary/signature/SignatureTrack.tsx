import css from "./SignatureTrack.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {SignatureTrackBody} from "@/ui/timeline/tracks/primary/signature/SignatureTrackBody.tsx"
import {SignatureTrackHeader} from "@/ui/timeline/tracks/primary/signature/SignatureTrackHeader.tsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "SignatureTrack")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const SignatureTrack = ({lifecycle, service}: Construct) => {
    return (
        <div className={className}>
            <SignatureTrackHeader lifecycle={lifecycle}
                                  editing={service.project.editing}
                                  timelineBox={service.project.timelineBox}/>
            <div className="void"/>
            <SignatureTrackBody lifecycle={lifecycle}
                                service={service}/>
        </div>
    )
}
