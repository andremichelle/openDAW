import {clamp, DefaultObservableValue, EmptyExec, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging} from "@opendaw/lib-dom"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput"
import {StudioService} from "@/service/StudioService"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ShuffleControl = ({lifecycle, service}: Construct) => {
    const {projectProfileService} = service
    const unitString = lifecycle.own(new DefaultObservableValue("60"))
    const projectActiveLifeTime = lifecycle.own(new Terminator())
    const amountOf = () => projectProfileService.getValue()
        .flatMap(({project}) => project.rootBoxAdapter.groove.amount)
    return (
        <DblClckTextInput numeric resolversFactory={() => {
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then((value: string) => {
                const percent = parseFloat(value)
                if (isNaN(percent)) {return}
                projectProfileService.getValue().ifSome(({project: {editing}}) => amountOf().ifSome(amount =>
                    editing.modify(() => amount.setValue(clamp(percent / 100.0, 0.0, 1.0)))))
            }, EmptyExec)
            return resolvers
        }} provider={() => ({unit: "%", value: amountOf().mapOr(amount => String(Math.round(amount.getValue() * 100)), "")})}>
            <UnitDisplay lifecycle={lifecycle} name="shuffle" value={unitString} numChars={3} onInit={element => {
                lifecycle.own(projectProfileService.catchupAndSubscribe(optProfile => {
                    projectActiveLifeTime.terminate()
                    if (optProfile.isEmpty()) {return}
                    const {project} = optProfile.unwrap()
                    const {editing, rootBoxAdapter} = project
                    const binding = projectActiveLifeTime.own(new Terminator())
                    const bind = () => {
                        binding.terminate()
                        rootBoxAdapter.groove.amount.match({
                            none: () => unitString.setValue("-"),
                            some: amount => binding.own(amount.catchupAndSubscribe(owner =>
                                unitString.setValue(String(Math.round(owner.getValue() * 100)))))
                        })
                    }
                    projectActiveLifeTime.ownAll(
                        rootBoxAdapter.box.groove.subscribe(() => bind()),
                        Dragging.attach(element, (event: PointerEvent) => amountOf().map(amount => {
                            const pointer = event.clientY
                            const oldValue = amount.getValue()
                            return {
                                update: (event: Dragging.Event) => {
                                    const newValue = clamp(oldValue + (pointer - event.clientY) * 0.005, 0.0, 1.0)
                                    editing.modify(() => amount.setValue(Math.round(newValue * 100) / 100), false)
                                },
                                cancel: () => editing.modify(() => amount.setValue(oldValue), false),
                                approve: () => editing.mark()
                            }
                        })))
                    bind()
                }))
            }}/>
        </DblClckTextInput>
    )
}
