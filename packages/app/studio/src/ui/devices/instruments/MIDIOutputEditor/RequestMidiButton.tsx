import css from "./RequestMidiButton.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {MidiDevices} from "@moises-ai/studio-core"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "RequestMidiButton")

export const RequestMidiButton = () => (
    <div className={className} onclick={() => MidiDevices.requestPermission()}>
        <span>Request </span><Icon symbol={IconSymbol.Midi}/>
    </div>
)