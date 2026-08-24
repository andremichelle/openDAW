import css from "./AudioUnitTracks.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "ModulatorLanes")

/// Every modulator's automation, grouped like a single audio unit that has no content track of its own.
export const ModulatorLanes = () => (<div className={Html.buildClassList(className, "modulator")}/>)
