import css from "./TextButton.sass?inline"
import {Exec} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "TextButton")

export const TextButton = ({onClick}: { onClick: Exec }) => (
    <div className={className} onclick={onClick}/>
)