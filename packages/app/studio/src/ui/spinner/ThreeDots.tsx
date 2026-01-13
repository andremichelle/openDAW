import css from "./ThreeDots.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"

const className = Html.adoptStyleSheet(css, "ThreeDots")

export const ThreeDots = () => {
    return (
        <svg classList={className} width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <circle class="spinner_I8Q1" cx="4" cy="12" r="1.5"/>
            <circle class="spinner_I8Q1 spinner_vrS7" cx="12" cy="12" r="3"/>
            <circle class="spinner_I8Q1" cx="20" cy="12" r="1.5"/>
        </svg>
    )
}