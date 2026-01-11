import {Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {VideoOverlayPreview} from "./VideoOverlayPreview"

const lifecycle = new Terminator()
document.body.appendChild(<VideoOverlayPreview lifecycle={lifecycle}/>)
