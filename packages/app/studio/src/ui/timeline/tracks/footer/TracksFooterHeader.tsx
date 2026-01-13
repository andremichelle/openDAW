import css from "./TracksFooterHeader.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"

const className = Html.adoptStyleSheet(css, "TracksFooterHeader")

export const TracksFooterHeader = () => {
    return (<div className={className}/>)
}