import css from "./TimeStateDisplay.sass?inline"
import {Attempt, clamp, EmptyExec, float, int, Lifecycle, ObservableValue, Option, Terminator} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput.tsx"
import {Html} from "@opendaw/lib-dom"
import {Propagation} from "@opendaw/lib-box"
import {ProjectProfile} from "@opendaw/studio-core"
import {TapButton} from "@/ui/header/TapButton"
import {Parsing} from "@opendaw/studio-adapters"
import {MusicalUnitDisplay} from "@/ui/header/MusicalUnitDisplay"
import {AbsoluteUnitDisplay} from "@/ui/header/AbsoluteUnitDisplay"
import {TempoControl} from "@/ui/header/TempoControl"

const className = Html.adoptStyleSheet(css, "TimeStateDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimeStateDisplay = ({lifecycle, service}: Construct) => {
    const {projectProfileService, timeline: {primaryVisibility: {signature: signatureVisible}}} = service
    const shuffleDigit = Inject.value("60")
    const meterLabel = Inject.value("4/4")

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
            timelineBoxAdapter.signatureTrack.subscribe(updateSignatureLabel),
            signatureVisible.subscribe(updateSignatureLabel),
            signatureTrack.subscribe(updateSignatureLabel),
            engine.position.subscribe(updateSignatureLabel)
        )
        updateSignatureLabel()
        rootBoxAdapter.groove.box.amount.catchupAndSubscribe((owner: ObservableValue<float>) =>
            shuffleDigit.value = String(Math.round(owner.getValue() * 100)))
    }
    lifecycle.own(projectProfileService.catchupAndSubscribe(projectProfileObserver))
    const element: HTMLElement = (
        <div className={className}>
            <MusicalUnitDisplay lifecycle={lifecycle} service={service}/>
            <AbsoluteUnitDisplay lifecycle={lifecycle} service={service}/>
            <TempoControl lifecycle={lifecycle} service={service}/>
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
    return element
}