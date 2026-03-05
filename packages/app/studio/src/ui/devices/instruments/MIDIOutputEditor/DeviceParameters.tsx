import css from "./DeviceParameters.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {clamp, int, Lifecycle, ParseResult, StringResult, Editing} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {NumberInput} from "@/ui/components/NumberInput"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {MIDIOutputDeviceBox} from "@opendaw/studio-boxes"

const className = Html.adoptStyleSheet(css, "DeviceParameters")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
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