import css from "./SoundCloudOptions.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "SoundCloudOptions")

type Construct = {
    lifecycle: Lifecycle
    isPrivate: MutableObservableValue<boolean>
}

export const SoundCloudOptions = ({lifecycle, isPrivate}: Construct) => (
    <div className={className}>
        <Checkbox lifecycle={lifecycle} model={isPrivate} appearance={{framed: true, color: Colors.black}}>
            <Icon symbol={IconSymbol.Checkbox}/>
        </Checkbox>
        <span onclick={() => isPrivate.setValue(!isPrivate.getValue())}>Upload privately</span>
    </div>
)
