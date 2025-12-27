import css from "./SignatureTrackHeader.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "SignatureTrackHeader")

export const SignatureTrackHeader = () => {
    return (<div className={className}>Signature</div>)
}
