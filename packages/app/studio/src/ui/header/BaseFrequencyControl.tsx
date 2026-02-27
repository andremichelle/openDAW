import css from "./BaseFrequencyControl.sass?inline"
import {DefaultObservableValue, EmptyExec, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {Dragging, Html} from "@opendaw/lib-dom"
import {StudioPreferences} from "@opendaw/studio-core"
import {BaseFrequencyRange, Validator} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "BaseFrequencyControl")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const BaseFrequencyControl = ({lifecycle, service}: Construct) => {
    const {projectProfileService} = service
    const unitString = lifecycle.own(new DefaultObservableValue(BaseFrequencyRange.default.toString()))
    const projectActiveLifeTime = lifecycle.own(new Terminator())
    const element: HTMLElement = (
        <div className={className}><DblClckTextInput numeric resolversFactory={() => {
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then((value: string) => {
                const parsed = parseFloat(value)
                if (isNaN(parsed)) {return}
                const clamped = Validator.clampBaseFrequency(parsed)
                projectProfileService.getValue()
                    .ifSome(({project: {editing, rootBox: {baseFrequency}}}) =>
                        editing.modify(() => baseFrequency.setValue(clamped)))
            }, EmptyExec)
            return resolvers
        }} provider={() => projectProfileService.getValue().match({
            none: () => ({unit: "Hz", value: ""}),
            some: ({project: {rootBox: {baseFrequency}}}) =>
                ({unit: "Hz", value: `${baseFrequency.getValue()}`})
        })}>
            <UnitDisplay lifecycle={lifecycle} name="Hz" value={unitString} numChars={2} onInit={element => {
                lifecycle.own(projectProfileService.catchupAndSubscribe(optProfile => {
                    projectActiveLifeTime.terminate()
                    if (optProfile.isEmpty()) {
                        unitString.setValue(BaseFrequencyRange.default.toString())
                        return
                    }
                    const {project} = optProfile.unwrap()
                    const {rootBox: {baseFrequency}} = project
                    projectActiveLifeTime.ownAll(
                        baseFrequency.catchupAndSubscribe(() => {
                            const value = baseFrequency.getValue()
                            element.classList.toggle("float", !Number.isInteger(value))
                            unitString.setValue(`${Math.floor(value)}`)
                        }),
                        Dragging.attach(element, (event: PointerEvent) => projectProfileService.getValue().match({
                            none: () => Option.None,
                            some: ({project}) => {
                                const {editing, rootBox: {baseFrequency}} = project
                                const pointer = event.clientY
                                const oldValue = baseFrequency.getValue()
                                return Option.wrap({
                                    update: (event: Dragging.Event) => {
                                        const newValue = Validator.clampBaseFrequency(Math.round(oldValue + (pointer - event.clientY)))
                                        editing.modify(() => baseFrequency.setValue(newValue), false)
                                    },
                                    cancel: () => editing.modify(() => baseFrequency.setValue(oldValue), false),
                                    approve: () => editing.mark()
                                })
                            }
                        }))
                    )
                }))
            }}/>
        </DblClckTextInput></div>
    )
    lifecycle.own(StudioPreferences.catchupAndSubscribe(enabled =>
        element.classList.toggle("hidden", !enabled), "visibility", "base-frequency"))
    return element
}
