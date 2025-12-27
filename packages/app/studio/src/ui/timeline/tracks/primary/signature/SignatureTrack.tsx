import css from "./SignatureTrack.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {SignatureTrackBody} from "@/ui/timeline/tracks/primary/signature/SignatureTrackBody.tsx"
import {SignatureTrackHeader} from "@/ui/timeline/tracks/primary/signature/SignatureTrackHeader.tsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "SignatureTrack")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const SignatureTrack = ({lifecycle, service}: Construct) => {
    return (
        <div className={className}>
            <SignatureTrackHeader/>
            <div className="void"/>
            <SignatureTrackBody lifecycle={lifecycle} service={service}/>
        </div>
    )
}
