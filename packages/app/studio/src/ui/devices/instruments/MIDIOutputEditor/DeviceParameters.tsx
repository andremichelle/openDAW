import css from "./DeviceParameters.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {clamp, int, Lifecycle, ParseResult, StringResult} from "@moises-ai/lib-std"
import {createElement, Frag} from "@moises-ai/lib-jsx"
import {NumberInput} from "@/ui/components/NumberInput"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {BoxEditing} from "@moises-ai/lib-box"
import {MIDIOutputDeviceBox} from "@moises-ai/studio-boxes"

const className = Html.adoptStyleSheet(css, "DeviceParameters")

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    box: MIDIOutputDeviceBox
}

export const DeviceParameters = ({lifecycle, editing, box: {channel}}: Construct) => (
    <Frag>
        <div className={className}>
            <span>Channel:</span>
            <NumberInput lifecycle={lifecycle}
                         model={EditWrapper.forValue(editing, channel)}
                         mapper={{
                             y: (x: string): ParseResult<number> => {
                                 const int = parseInt(x)
                                 return Number.isFinite(int)
                                     ? {type: "explicit", value: int - 1}
                                     : {type: "unknown", value: x}
                             },
                             x: (y: number): StringResult => ({
                                 unit: "#",
                                 value: String(y + 1)
                             })
                         }}
                         guard={{
                             guard: (value: int): int => clamp(value, 0, 15)
                         }}
            />
        </div>
    </Frag>
)