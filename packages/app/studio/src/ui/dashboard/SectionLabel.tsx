import css from "./SectionLabel.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement, JsxValue} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "SectionLabel")

// The single small uppercase label at the top of every dashboard block (rail sections, start buttons, intro tiles).
export const SectionLabel = ({title}: { title: JsxValue }) => (
    <div className={className}>{title}</div>
)
