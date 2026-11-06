import css from "./KeyControl.sass?inline"
import {Arrays, DefaultObservableValue, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {StudioService} from "@/service/StudioService"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "KeyControl")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const KeyControl = ({lifecycle, service}: Construct) => {
    const {projectProfileService, timeline: {primaryVisibility: {key: keyVisible, chords: chordsVisible}}} = service
    const unitString = lifecycle.own(new DefaultObservableValue("C"))
    const projectActiveLifeTime = lifecycle.own(new Terminator())
    return (
        <UnitDisplay lifecycle={lifecycle} name="key" value={unitString} numChars={4} onInit={element => {
            element.classList.add(className)
            lifecycle.own(projectProfileService.catchupAndSubscribe(optProfile => {
                projectActiveLifeTime.terminate()
                if (optProfile.isEmpty()) {
                    unitString.setValue(MidiKeys.Names.English[Harmony.DefaultKey.root])
                    element.firstElementChild?.setAttribute("data-scale", Harmony.scaleAbbreviation(Harmony.DefaultKey.bits))
                    element.removeAttribute("title")
                    element.classList.remove("automated")
                    return
                }
                const {project} = optProfile.unwrap()
                const {editing, engine, timelineBoxAdapter: {keyTrack}} = project
                const updateKeyLabel = () => {
                    const key = keyTrack.keyAt(engine.position.getValue())
                    unitString.setValue(MidiKeys.Names.English[key.root])
                    element.firstElementChild?.setAttribute("data-scale", Harmony.scaleAbbreviation(key.bits))
                    element.title = Harmony.keyName(key)
                    element.classList.toggle("automated", keyTrack.enabled && !keyTrack.events.isEmpty())
                }
                updateKeyLabel()
                projectActiveLifeTime.ownAll(
                    keyTrack.subscribe(updateKeyLabel),
                    engine.position.subscribe(updateKeyLabel),
                    ContextMenu.subscribe(element, (collector: ContextMenu.Collector) => {
                        const current = keyTrack.storageKey
                        const {root, scale} = keyTrack.object
                        collector.addItems(
                            MenuItem.default({label: "Root"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                                ...Arrays.create(index => MenuItem.default({
                                    label: MidiKeys.Names.English[index],
                                    checked: index === current.root
                                }).setTriggerProcedure(() => editing.modify(() => root.setValue(index))), 12))),
                            MenuItem.default({label: "Scale"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                                ...MidiKeys.StockScales.map(stock => MenuItem.default({
                                    label: stock.name,
                                    checked: stock.bits === current.bits
                                }).setTriggerProcedure(() => editing.modify(() => scale.setValue(stock.bits)))))),
                            MenuItem.default({label: "Show Key Track", checked: keyVisible.getValue()})
                                .setTriggerProcedure(() => keyVisible.setValue(!keyVisible.getValue())),
                            MenuItem.default({label: "Show Chord Track", checked: chordsVisible.getValue()})
                                .setTriggerProcedure(() => chordsVisible.setValue(!chordsVisible.getValue())))
                    })
                )
            }))
        }}/>
    )
}
