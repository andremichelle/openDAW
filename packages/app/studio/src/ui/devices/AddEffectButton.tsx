import css from "./AddEffectButton.sass?inline"
import {Procedure} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {EffectFactories, EffectFactory, MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "AddEffectButton")

type Construct = {
    // What to do with the chosen effect: insert it into a chain, or spin up a new composite branch holding it.
    select: Procedure<EffectFactory>
    onInit?: Procedure<HTMLElement>
    label?: string
}

// A dropdown "Add Effect" button styled like the timeline header's "Add instrument" button. The list is the
// stock audio effects; the caller decides what a pick does.
export const AddEffectButton = ({select, onInit, label = "Add Effect"}: Construct) => (
    <div className={className}>
        <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent
            .addMenuItem(...EffectFactories.AudioList.map(factory => MenuItem.default({
                label: factory.defaultName,
                icon: factory.defaultIcon,
                separatorBefore: factory.separatorBefore
            }).setTriggerProcedure(() => select(factory)))))}
                    appearance={{color: Colors.shadow}}
                    onInit={onInit}>
            <span>{label}</span> <Icon symbol={IconSymbol.Add}/>
        </MenuButton>
    </div>
)
