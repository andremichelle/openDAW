import css from "./TimeStateDisplay.sass?inline"
import {
    Attempt,
    clamp,
    DefaultObservableValue,
    EmptyExec,
    float,
    int,
    Lifecycle,
    ObservableValue,
    Option,
    Terminator
} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput.tsx"
import {Dragging, Html} from "@opendaw/lib-dom"
import {Propagation} from "@opendaw/lib-box"
import {ProjectProfile} from "@opendaw/studio-core"
import {TapButton} from "@/ui/header/TapButton"
import {Parsing, Validator} from "@opendaw/studio-adapters"
import {MusicalUnitDisplay} from "@/ui/header/MusicalUnitDisplay"
import {MenuItem} from "@/ui/model/menu-item"
import {ContextMenu} from "@/ui/ContextMenu"
import {AbsoluteUnitDisplay} from "@/ui/header/AbsoluteUnitDisplay"
import {UnitDisplay} from "@/ui/header/UnitDisplay"

const className = Html.adoptStyleSheet(css, "TimeStateDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimeStateDisplay = ({lifecycle, service}: Construct) => {
    const {projectProfileService, timeline: {primaryVisibility: {tempo, signature: signatureVisible}}} = service
    const shuffleDigit = Inject.value("60")
    const meterLabel = Inject.value("4/4")
    const bpmUnitString = new DefaultObservableValue("120")
    const bpmDisplay: HTMLElement = (
        <UnitDisplay lifecycle={lifecycle} name="bpm" value={bpmUnitString} numChars={3}/>
    )
    const projectActiveLifeTime = lifecycle.own(new Terminator())
    const projectProfileObserver = (optProfile: Option<ProjectProfile>) => {
        projectActiveLifeTime.terminate()
        if (optProfile.isEmpty()) {return}
        const {project} = optProfile.unwrap()
        const {timelineBoxAdapter, rootBoxAdapter, boxGraph, engine} = project
        const {signatureTrack} = timelineBoxAdapter
        const updateSignatureLabel = () => {
            const [nominator, denominator] = signatureTrack.enabled
                ? signatureTrack.signatureAt(engine.position.getValue())
                : timelineBoxAdapter.signature
            meterLabel.value = `${nominator}/${denominator}`
        }
        projectActiveLifeTime.ownAll(
            boxGraph.subscribeVertexUpdates(Propagation.Children,
                timelineBoxAdapter.box.signature.address, updateSignatureLabel),
            engine.bpm.catchupAndSubscribe((owner: ObservableValue<float>) => {
                const bpm = owner.getValue()
                bpmDisplay.classList.toggle("float", !Number.isInteger(bpm))
                return bpmUnitString.setValue(`${Math.floor(bpm)}`)
            }),
            timelineBoxAdapter.signatureTrack.subscribe(updateSignatureLabel),
            timelineBoxAdapter.catchupAndSubscribeTempoAutomation(opt =>
                bpmDisplay.classList.toggle("automated", opt.nonEmpty())),
            signatureVisible.subscribe(updateSignatureLabel),
            signatureTrack.subscribe(updateSignatureLabel),
            engine.position.subscribe(updateSignatureLabel)
        )
        updateSignatureLabel()
        rootBoxAdapter.groove.box.amount.catchupAndSubscribe((owner: ObservableValue<float>) =>
            shuffleDigit.value = String(Math.round(owner.getValue() * 100)))
    }
    lifecycle.own(projectProfileService.catchupAndSubscribe(projectProfileObserver))
    lifecycle.own(Dragging.attach(bpmDisplay, (event: PointerEvent) => projectProfileService.getValue().match({
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
    })))
    const element: HTMLElement = (
        <div className={className}>
            <MusicalUnitDisplay lifecycle={lifecycle} service={service}/>
            <AbsoluteUnitDisplay lifecycle={lifecycle} service={service}/>
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
                some: ({project: {timelineBox: {bpm}}}) => ({unit: "bpm", value: bpm.getValue().toString()})
            })}>{bpmDisplay}</DblClckTextInput>
            <TapButton service={service}/>
            <DblClckTextInput resolversFactory={() => {
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
            }} provider={() => ({unit: "", value: meterLabel.value})}>
                <div className="number-display">
                    <div>{meterLabel}</div>
                    <div>METER</div>
                </div>
            </DblClckTextInput>
            <DblClckTextInput numeric resolversFactory={() => {
                const resolvers = Promise.withResolvers<string>()
                resolvers.promise.then((value: string) => {
                    const amount = parseFloat(value)
                    if (isNaN(amount)) {return}
                    projectProfileService.getValue().ifSome(({project}) =>
                        project.editing.modify(() => project.rootBoxAdapter.groove.box.amount
                            .setValue(clamp(amount / 100.0, 0.0, 1.0))))
                }, EmptyExec)
                return resolvers
            }} provider={() => ({unit: "shuffle", value: shuffleDigit.value})}>
                <div className="number-display hidden">
                    <div>{shuffleDigit}</div>
                    <div>SHUF</div>
                </div>
            </DblClckTextInput>
        </div>
    )
    const collectTempoMenu = (collector: ContextMenu.Collector) =>
        collector.addItems(
            MenuItem.default({
                label: "Show Tempo Automation",
                checked: tempo.getValue()
            }).setTriggerProcedure(() => tempo.setValue(!tempo.getValue())),
            MenuItem.default({
                label: "Enable Automation",
                checked: projectProfileService.getValue()
                    .mapOr(({project: {timelineBox: {tempoTrack: {enabled}}}}) => enabled.getValue(), false)
            }).setTriggerProcedure(() => projectProfileService.getValue()
                .ifSome(({project: {editing, timelineBox: {tempoTrack: {enabled}}}}) =>
                    editing.modify(() => enabled.setValue(!enabled.getValue()))))
        )
    lifecycle.ownAll(
        ContextMenu.subscribe(bpmDisplay, collectTempoMenu)
    )
    return element
}