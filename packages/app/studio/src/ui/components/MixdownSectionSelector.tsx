import css from "./MixdownSectionSelector.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {MixdownSection} from "@opendaw/studio-core"
import {DropDown} from "@/ui/composite/DropDown"

const className = Html.adoptStyleSheet(css, "MixdownSectionSelector")

type Construct = {
    lifecycle: Lifecycle
    sections: ReadonlyArray<MixdownSection>
    model: MutableObservableValue<MixdownSection>
}

export const MixdownSectionSelector = ({lifecycle, sections, model}: Construct) => (
    <div className={className}>
        <span>Section</span>
        <DropDown lifecycle={lifecycle}
                  owner={model}
                  provider={() => sections}
                  mapping={section => section.label}
                  width="12em"/>
    </div>
)
