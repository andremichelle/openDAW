import css from "./RailFooterLink.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement, JsxValue} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "RailFooterLink")

export const RailFooterLink = ({href}: { href: string }, children: JsxValue) => (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
)