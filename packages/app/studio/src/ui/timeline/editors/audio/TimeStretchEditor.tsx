import css from "./TimeStretchEditor.sass?inline"
import {Events, Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle, Nullable, StringMapping, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol, TransientPlayMode} from "@opendaw/studio-enums"
import {Project} from "@opendaw/studio-core"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Icon} from "@/ui/components/Icon"
import {NumberInput} from "@/ui/components/NumberInput"

const className = Html.adoptStyleSheet(css, "TimeStretchEditor")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    reader: AudioEventOwnerReader
}

export const TimeStretchEditor = ({lifecycle, project, reader}: Construct) => {
    const {editing} = project
    const {audioContent} = reader
    const transientPlayModeEnumValue = new DefaultObservableValue<Nullable<TransientPlayMode>>(null)
    const activeLifecycle = lifecycle.own(new Terminator())
    const observableCents = new DefaultObservableValue(0.0)
    return (
        <div className={className} onInit={element => {
            lifecycle.ownAll(
                audioContent.box.playMode.catchupAndSubscribe(() => {
                    activeLifecycle.terminate()
                    audioContent.asPlayModeTimeStretch.match({
                        none: () => transientPlayModeEnumValue.setValue(null),
                        some: adapter => {
                            activeLifecycle.ownAll(
                                adapter.box.transientPlayMode.catchupAndSubscribe(transientPlayMode =>
                                    transientPlayModeEnumValue.setValue(transientPlayMode.getValue())),
                                adapter.box.playbackRate
                                    .catchupAndSubscribe(() => observableCents.setValue(adapter.cents)),
                                observableCents.subscribe(owner => {
                                    const value = owner.getValue()
                                    if (editing.mustModify()) {
                                        editing.modify(() => adapter.cents = value)
                                    } else {
                                        adapter.cents = value
                                    }
                                })
                            )
                        }
                    })
                    const disabled = transientPlayModeEnumValue.getValue() === null
                    element.classList.toggle("disabled", disabled)
                    if (disabled) {
                        activeLifecycle.own(Events.subscribe(element, "click", event => {
                            event.preventDefault()
                            event.stopImmediatePropagation()
                        }, {capture: true, passive: false}))
                    }
                }),
                transientPlayModeEnumValue.subscribe(owner => audioContent.asPlayModeTimeStretch
                    .ifSome(adapter => {
                        const value = owner.getValue() ?? TransientPlayMode.Once
                        if (editing.mustModify()) {
                            editing.modify(() => adapter.box.transientPlayMode.setValue(value))
                        } else {
                            adapter.box.transientPlayMode.setValue(value)
                        }
                    }))
            )
        }}>
            <RadioGroup lifecycle={lifecycle}
                        model={transientPlayModeEnumValue}
                        elements={[
                            {
                                value: TransientPlayMode.Once,
                                element: (<Icon symbol={IconSymbol.PlayOnce}/>),
                                tooltip: "Play transient once"
                            },
                            {
                                value: TransientPlayMode.Repeat,
                                element: (<Icon symbol={IconSymbol.PlayRepeat}/>),
                                tooltip: "Repeat transient"
                            },
                            {
                                value: TransientPlayMode.Pingpong,
                                element: (<Icon symbol={IconSymbol.PlayAlternate}/>),
                                tooltip: "Alternate playback"
                            }
                        ]}/>
            <NumberInput lifecycle={lifecycle}
                         mapper={StringMapping.numeric({unit: "cents"})}
                         className="input"
                         maxChars={4}
                         step={1}
                         model={observableCents}/>
            <span>cents</span>
        </div>
    )
}