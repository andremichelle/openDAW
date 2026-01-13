import css from "./FlexSpace.sass?inline"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "FlexSpace")

export const FlexSpace = () => (<div className={className}/>)