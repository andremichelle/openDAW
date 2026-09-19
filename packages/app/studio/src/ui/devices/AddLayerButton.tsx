import css from "./AddEffectButton.sass?inline"
import {Procedure} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {InstrumentFactories, InstrumentFactory} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "AddEffectButton")

type Construct = {
    select: Procedure<InstrumentFactory>
}

export const AddLayerButton = ({select}: Construct) => (
    <div className={className}>
        <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent
            .addMenuItem(...Object.values(InstrumentFactories.Named)
                .filter(factory => InstrumentFactories.isLayerInstrument(factory))
                .map(factory => MenuItem.default({label: factory.defaultName, icon: factory.defaultIcon})
                    .setTriggerProcedure(() => select(factory)))))}
                    appearance={{color: Colors.shadow}}>
            <span>Add Layer</span> <Icon symbol={IconSymbol.Add}/>
        </MenuButton>
    </div>
)
