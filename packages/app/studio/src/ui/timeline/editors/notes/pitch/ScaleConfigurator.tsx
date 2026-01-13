import css from "./ScaleConfigurator.sass?inline"
import {Arrays, int, Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {ScaleConfig} from "@/ui/timeline/editors/notes/pitch/ScaleConfig.ts"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "ScaleConfigurator")

type Construct = {
    lifecycle: Lifecycle
    scale: ScaleConfig
}

export const ScaleConfigurator = ({lifecycle, scale}: Construct) => {
    const buttons: ReadonlyArray<HTMLDivElement> = Arrays.create((index: int) => (
        <div onclick={() => scale.toggle(index)}/>
    ), 12)
    const updater = () => buttons.forEach((button, index) => button.classList.toggle("active", scale.getBit(index)))
    lifecycle.own(scale.subscribe(updater))
    updater()
    return (<div className={className}>{buttons}</div>)
}