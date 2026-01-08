import {Attempt, DefaultObservableValue, EmptyExec, int, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput"
import {Parsing} from "@opendaw/studio-adapters"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {Propagation} from "@opendaw/lib-box"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MeterControl = ({lifecycle, service}: Construct) => {
    const {projectProfileService, timeline: {primaryVisibility: {signature: signatureVisible}}} = service
    const unitString = lifecycle.own(new DefaultObservableValue("4/4"))
    const projectActiveLifeTime = lifecycle.own(new Terminator())
    return (
        <DblClckTextInput numeric resolversFactory={() => {
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then((value: string) => {
                const attempt: Attempt<[int, int], string> = Parsing.parseTimeSignature(value)
                if (attempt.isSuccess()) {
                    const [nominator, denominator] = attempt.result()
                    projectProfileService.getValue()
                        .ifSome(({project: {editing, timelineBoxAdapter: {signatureTrack}}}) =>
                            editing.modify(() => signatureTrack.changeSignature(nominator, denominator)))
                }
            }, EmptyExec)
            return resolvers
        }} provider={() => projectProfileService.getValue().match({
            none: () => ({unit: "", value: ""}),
            some: ({project: {timelineBox: {signature: {nominator, denominator}}}}) =>
                ({unit: "", value: `${nominator.getValue()}/${denominator.getValue()}`})
        })}>
            <UnitDisplay lifecycle={lifecycle} name="meter" value={unitString} numChars={3} onInit={element => {
                lifecycle.own(projectProfileService.catchupAndSubscribe(optProfile => {
                    projectActiveLifeTime.terminate()
                    if (optProfile.isEmpty()) {return}
                    const {project} = optProfile.unwrap()
                    const {boxGraph, timelineBoxAdapter, engine} = project
                    const {signatureTrack} = timelineBoxAdapter
                    const updateSignatureLabel = () => {
                        const [nominator, denominator] = signatureTrack.enabled
                            ? signatureTrack.signatureAt(engine.position.getValue())
                            : timelineBoxAdapter.signature
                        unitString.setValue(`${nominator}/${denominator}`)
                        element.classList.toggle("automated", signatureTrack.enabled && signatureTrack.nonEmpty())
                    }
                    updateSignatureLabel()
                    projectActiveLifeTime.ownAll(
                        boxGraph.subscribeVertexUpdates(Propagation.Children,
                            timelineBoxAdapter.box.signature.address, updateSignatureLabel),
                        timelineBoxAdapter.signatureTrack.subscribe(updateSignatureLabel),
                        signatureVisible.subscribe(updateSignatureLabel),
                        signatureTrack.subscribe(updateSignatureLabel),
                        engine.position.subscribe(updateSignatureLabel),
                        ContextMenu.subscribe(element, (collector: ContextMenu.Collector) =>
                            collector.addItems(
                                MenuItem.default({
                                    label: "Show Signature Automation",
                                    checked: signatureVisible.getValue(),
                                    shortcut: GlobalShortcuts["toggle-signature-track"].shortcut.format()
                                }).setTriggerProcedure(() => signatureVisible.setValue(!signatureVisible.getValue())),
                                MenuItem.default({
                                    label: "Enable Automation",
                                    checked: projectProfileService.getValue()
                                        .mapOr(({project: {timelineBox: {signatureTrack: {enabled}}}}) =>
                                            enabled.getValue(), false)
                                }).setTriggerProcedure(() => projectProfileService.getValue()
                                    .ifSome(({project: {editing, timelineBox: {signatureTrack: {enabled}}}}) =>
                                        editing.modify(() => enabled.setValue(!enabled.getValue()))))
                            ))
                    )
                }))
            }}/>
        </DblClckTextInput>
    )
}