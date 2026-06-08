import css from "./ThreeDots.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "ThreeDots")

export const ThreeDots = ({style}: { style?: Partial<CSSStyleDeclaration> } = {}) => {
    return (
        <svg classList={className}
             width="24" height="24"
             viewBox="0 0 24 24"
             fill="currentColor"
             style={style}
             xmlns="http://www.w3.org/2000/svg">
            <circle cx="4" cy="12" r="1.5"/>
            <circle cx="12" cy="12" r="3"/>
            <circle cx="20" cy="12" r="1.5"/>
        </svg>
    )
}