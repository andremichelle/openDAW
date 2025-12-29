import {
    DefaultObservableValue,
    EmptyExec,
    float,
    Lifecycle,
    ObservableValue,
    Option,
    Terminator
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {Dragging} from "@opendaw/lib-dom"
import {Validator} from "@opendaw/studio-adapters"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput"
import {ContextMenu} from "@/ui/ContextMenu"
import {MenuItem} from "@/ui/model/menu-item"
import {StudioService} from "@/service/StudioService"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TempoControl = ({lifecycle, service}: Construct) => {
    const {projectProfileService, timeline: {primaryVisibility: {tempo}}} = service
    const unitString = lifecycle.own(new DefaultObservableValue("120"))
    const projectActiveLifeTime = lifecycle.own(new Terminator())
    return (
        <DblClckTextInput numeric resolversFactory={() => {
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then((value: string) => {
                const bpmValue = parseFloat(value)
                if (isNaN(bpmValue)) {return}
                projectProfileService.getValue().ifSome(({project: {editing, timelineBox: {bpm}}}) =>
                    editing.modify(() => bpm.setValue(Validator.clampBpm(bpmValue))))
            }, EmptyExec)
            return resolvers
        }} provider={() => projectProfileService.getValue().match({
            none: () => ({unit: "bpm", value: ""}),
            some: ({project: {timelineBox: {bpm}}}) => ({unit: "bpm", value: bpm.getValue().toFixed(3)})
        })}>
            <UnitDisplay lifecycle={lifecycle} name="bpm" value={unitString} numChars={3} onInit={element => {
                lifecycle.own(projectProfileService.catchupAndSubscribe(optProfile => {
                    projectActiveLifeTime.terminate()
                    if (optProfile.isEmpty()) {return}
                    const {project} = optProfile.unwrap()
                    const {timelineBoxAdapter, engine} = project
                    projectActiveLifeTime.ownAll(
                        engine.bpm.catchupAndSubscribe((owner: ObservableValue<float>) => {
                            const bpm = owner.getValue()
                            element.classList.toggle("float", !Number.isInteger(bpm))
                            return unitString.setValue(`${Math.floor(bpm)}`)
                        }),
                        timelineBoxAdapter.catchupAndSubscribeTempoAutomation(opt =>
                            element.classList.toggle("automated", opt.nonEmpty())),
                        Dragging.attach(element, (event: PointerEvent) => projectProfileService.getValue().match({
                            none: () => Option.None,
                            some: ({project}) => {
                                const {editing} = project
                                const bpmField = project.timelineBox.bpm
                                const pointer = event.clientY
                                const oldValue = bpmField.getValue()
                                return Option.wrap({
                                    update: (event: Dragging.Event) => {
                                        const newValue = Validator.clampBpm(oldValue + (pointer - event.clientY) * 2.0)
                                        editing.modify(() => project.timelineBox.bpm.setValue(Math.round(newValue)), false)
                                    },
                                    cancel: () => editing.modify(() => project.timelineBox.bpm.setValue(oldValue), false),
                                    approve: () => editing.mark()
                                })
                            }
                        })),
                        ContextMenu.subscribe(element, (collector: ContextMenu.Collector) =>
                            collector.addItems(
                                MenuItem.default({
                                    label: "Show Tempo Automation",
                                    checked: tempo.getValue(),
                                    shortcut: GlobalShortcuts["toggle-tempo-track"].shortcut.format()
                                }).setTriggerProcedure(() => tempo.setValue(!tempo.getValue())),
                                MenuItem.default({
                                    label: "Enable Automation",
                                    checked: projectProfileService.getValue()
                                        .mapOr(({project: {timelineBox: {tempoTrack: {enabled}}}}) =>
                                            enabled.getValue(), false)
                                }).setTriggerProcedure(() => projectProfileService.getValue()
                                    .ifSome(({project: {editing, timelineBox: {tempoTrack: {enabled}}}}) =>
                                        editing.modify(() => enabled.setValue(!enabled.getValue()))))
                            ))
                    )
                }))
            }}/>
        </DblClckTextInput>
    )
}