import css from "./SectionLabel.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement, JsxValue} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "SectionLabel")

export const SectionLabel = ({title}: { title: JsxValue }) => (
    <div className={className}>{title}</div>
)
