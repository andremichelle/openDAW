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
import {createElement, Frag, Inject} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {PPQN} from "@opendaw/lib-dsp"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput.tsx"
import {ContextMenu} from "@/ui/ContextMenu.ts"
import {MenuItem} from "@/ui/model/menu-item.ts"
import {Dragging, Html} from "@opendaw/lib-dom"
import {FlexSpacer} from "@/ui/components/FlexSpacer.tsx"
import {Propagation} from "@opendaw/lib-box"
import {ProjectProfile} from "@opendaw/studio-core"
import {TapButton} from "@/ui/header/TapButton"
import {Parsing, Validator} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "TimeStateDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimeStateDisplay = ({lifecycle, service}: Construct) => {
    const {projectProfileService, timeline: {primaryVisibility: {tempo}}} = service
    const barDigits = Inject.value("001")
    const beatDigit = Inject.value("1")
    const semiquaverDigit = Inject.value("1")
    const ticksDigit = Inject.value("000")
    const shuffleDigit = Inject.value("60")
    const bpmDigit = Inject.value("120")
    const meterLabel = Inject.value("4/4")
    const bpmDisplay: HTMLElement = (
        <div className="number-display">
            <div>{bpmDigit}</div>
            <div>BPM</div>
        </div>
    )
    // Bar, Bar+Beats, Bar+Beats+SemiQuaver, Bar+Beats+SemiQuaver+Ticks
    const timeUnits = ["Bar", "Beats", "SemiQuaver", "Ticks"] // Bar+Beats
    const timeUnitIndex = new DefaultObservableValue(1)
    const projectActiveLifeTime = lifecycle.own(new Terminator())
    const projectProfileObserver = (optProfile: Option<ProjectProfile>) => {
        projectActiveLifeTime.terminate()
        if (optProfile.isEmpty()) {return}
        const {project} = optProfile.unwrap()
        const {timelineBoxAdapter, rootBoxAdapter, boxGraph, engine} = project
        projectActiveLifeTime.own(service.engine.position.catchupAndSubscribe((owner: ObservableValue<number>) => {
            const position = owner.getValue()
            const {bars, beats, semiquavers, ticks} = PPQN.toParts(Math.abs(position))
            barDigits.value = (bars + 1).toString().padStart(3, "0")
            beatDigit.value = (beats + 1).toString()
            semiquaverDigit.value = (semiquavers + 1).toString()
            ticksDigit.value = ticks.toString().padStart(3, "0")
            timeUnitElements.forEach((element) => element.classList.toggle("negative", position < 0))
        }))
        engine.bpm.catchupAndSubscribe((owner: ObservableValue<float>) => {
            const bpm = owner.getValue()
            bpmDisplay.classList.toggle("float", !Number.isInteger(bpm))
            return bpmDigit.value = `${Math.floor(bpm)}`
        })
        const updateMeterLabel = () => {
            const {nominator, denominator} = timelineBoxAdapter.box.signature
            meterLabel.value = `${nominator.getValue()}/${denominator.getValue()}`
        }
        boxGraph.subscribeVertexUpdates(Propagation.Children, timelineBoxAdapter.box.signature.address, updateMeterLabel)
        updateMeterLabel()
        rootBoxAdapter.groove.box.amount.catchupAndSubscribe((owner: ObservableValue<float>) =>
            shuffleDigit.value = String(Math.round(owner.getValue() * 100)))
    }
    const barDisplay: HTMLElement = (
        <div className="number-display">
            <div>{barDigits}</div>
            <div>BAR</div>
        </div>
    )
    const beatDisplay: HTMLElement = (
        <div className="number-display">
            <div>{beatDigit}</div>
            <div>BEAT</div>
        </div>
    )
    const semiquaverDisplay: HTMLElement = (
        <div className="number-display">
            <div>{semiquaverDigit}</div>
            <div>SEMI</div>
        </div>
    )
    const ticksDisplay: HTMLElement = (
        <div className="number-display">
            <div>{ticksDigit}</div>
            <div>TICKS</div>
        </div>
    )
    const timeUnitElements: ReadonlyArray<HTMLElement> = (
        <Frag>
            {barDisplay}
            {beatDisplay}
            {semiquaverDisplay}
            {ticksDisplay}
        </Frag>
    )
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
    lifecycle.own(timeUnitIndex.catchupAndSubscribe(owner =>
        timeUnitElements.forEach((element, index) => element.classList.toggle("hidden", index > owner.getValue()))))
    const element: HTMLElement = (
        <div className={className}>
            {timeUnitElements}
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
                none: () => ({unit: "bpm", value: bpmDigit.value}),
                some: ({project: {timelineBox: {bpm}}}) => ({unit: "bpm", value: bpm.getValue().toString()})
            })}>{bpmDisplay}</DblClckTextInput>
            <TapButton service={service}/>
            <FlexSpacer pixels={3}/>
            <DblClckTextInput resolversFactory={() => {
                const resolvers = Promise.withResolvers<string>()
                resolvers.promise.then((value: string) => {
                    const attempt: Attempt<[int, int], string> = Parsing.parseTimeSignature(value)
                    if (attempt.isSuccess()) {
                        const [nominator, denominator] = attempt.result()
                        projectProfileService.getValue()
                            .ifSome(({project: {editing, rootBoxAdapter: {timeline: {box: {signature}}}}}) =>
                                editing.modify(() => {
                                    signature.nominator.setValue(clamp(nominator, 1, 32))
                                    signature.denominator.setValue(clamp(denominator, 1, 32))
                                }))
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
    const collectUnitMenu = (collector: ContextMenu.Collector) => collector.addItems(MenuItem.default({label: "Units"})
        .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
            ...timeUnits.map((_, index) => MenuItem.default({
                label: timeUnits.slice(0, index + 1).join(" > "),
                checked: index === timeUnitIndex.getValue()
            }).setTriggerProcedure(() => timeUnitIndex.setValue(index)))
        )))
    const collectTempoMenu = (collector: ContextMenu.Collector) =>
        collector.addItems(MenuItem.default({
            label: "Show Tempo Automation",
            checked: tempo.getValue()
        }).setTriggerProcedure(() => tempo.setValue(!tempo.getValue())))
    lifecycle.ownAll(
        ContextMenu.subscribe(barDisplay, collectUnitMenu),
        ContextMenu.subscribe(beatDisplay, collectUnitMenu),
        ContextMenu.subscribe(semiquaverDisplay, collectUnitMenu),
        ContextMenu.subscribe(ticksDisplay, collectUnitMenu),
        ContextMenu.subscribe(bpmDisplay, collectTempoMenu)
    )
    return element
}