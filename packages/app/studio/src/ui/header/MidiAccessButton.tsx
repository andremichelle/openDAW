import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MidiDevices} from "@opendaw/studio-core"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

type Construct = {
    lifecycle: Lifecycle
    style?: Partial<CSSStyleDeclaration>
}

export const MidiAccessButton = ({lifecycle, style}: Construct) => (
    <Checkbox lifecycle={lifecycle}
              model={MidiDevices.available()}
              style={style}
              appearance={{activeColor: Colors.orange, tooltip: "Midi Access", cursor: "pointer"}}>
        <Icon symbol={IconSymbol.Midi}/>
    </Checkbox>
)
