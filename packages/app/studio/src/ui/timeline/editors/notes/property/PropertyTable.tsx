import css from "./PropertyTable.sass?inline"
import {Arrays, Lifecycle, Nullable, Option, Selection} from "@moises-ai/lib-std"
import {deferNextFrame, Html} from "@moises-ai/lib-dom"
import {TimeCodeInput} from "@/ui/components/TimeCodeInput.tsx"
import {PropertyParameters} from "@/ui/timeline/editors/notes/property/PropertyParameters.ts"
import {NumberInput} from "@/ui/components/NumberInput.tsx"
import {createElement, Inject} from "@moises-ai/lib-jsx"
import {MidiKeys} from "@moises-ai/lib-dsp"
import {NoteEventBoxAdapter} from "@moises-ai/studio-adapters"
import {IconSymbol} from "@moises-ai/studio-enums"
import {BoxEditing} from "@moises-ai/lib-box"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {NoteModifyStrategies} from "@/ui/timeline/editors/notes/NoteModifyStrategies.ts"
import {Icon} from "@/ui/components/Icon.tsx"

const className = Html.adoptStyleSheet(css, "PropertyTable")

type Construct = {
    lifecycle: Lifecycle
    selection: Selection<NoteEventBoxAdapter>
    modifyContext: ObservableModifyContext<NoteModifier>
    editing: BoxEditing
}

export const PropertyTable = ({lifecycle, selection, modifyContext, editing}: Construct) => {
    const {position, duration, pitch, velocity, cent, chance, playCount, playCurve} = PropertyParameters
    const positionInput: Element = <TimeCodeInput lifecycle={lifecycle}
                                                  model={position.parameter}
                                                  negativeWarning
                                                  oneBased/>
    const durationInput: Element = <TimeCodeInput lifecycle={lifecycle}
                                                  model={duration.parameter}
                                                  negativeWarning/>
    const pitchString = Inject.value(MidiKeys.toFullString(pitch.parameter.getValue()))
    const pitchInput: Element = <NumberInput lifecycle={lifecycle}
                                             model={pitch.parameter}/>
    const velocityInput: Element = <NumberInput lifecycle={lifecycle}
                                                model={velocity.parameter}
                                                mapper={velocity.parameter.stringMapping}
                                                step={0.01}/>
    const centInput: Element = <NumberInput lifecycle={lifecycle}
                                            model={cent.parameter}/>
    const chanceInput: Element = <NumberInput lifecycle={lifecycle}
                                              model={chance.parameter}/>
    const playCountInput: Element = <NumberInput lifecycle={lifecycle}
                                                 model={playCount.parameter}/>
    const playCurveInput: Element = <NumberInput lifecycle={lifecycle}
                                                 model={playCurve.parameter}
                                                 mapper={playCurve.parameter.stringMapping}
                                                 step={0.01}/>
    const element: HTMLElement = (
        <div className={className}>
            <Icon symbol={IconSymbol.Start}/>
            {positionInput}
            <div/>
            <Icon symbol={IconSymbol.Duration}/>
            {durationInput}
            <Icon symbol={IconSymbol.Piano}/>
            <div className="group">
                {pitchInput}
                <div className="unit">{pitchString}</div>
            </div>
            <div/>
            <Icon symbol={IconSymbol.Velocity}/>
            <div className="group">
                {velocityInput}
                <div className="unit">%</div>
            </div>
            <Icon symbol={IconSymbol.Dial}/>
            <div className="group">
                {centInput}
                <div className="unit">cents</div>
            </div>
            <div/>
            <Icon symbol={IconSymbol.Random}/>
            <div className="group">
                {chanceInput}
                <div className="unit">%</div>
            </div>
            <Icon symbol={IconSymbol.Divide}/>
            <div className="group connect">
                {playCountInput}
                <div className="unit">#</div>
                <hr/>
            </div>
            <Icon symbol={IconSymbol.Curve}/>
            <div className="group">
                {playCurveInput}
                <div className="unit">%</div>
            </div>
        </div>
    )

    let focus: Nullable<NoteEventBoxAdapter> = null

    const updateState = lifecycle.own(deferNextFrame(() => {
        if (selection.isEmpty()) {
            element.classList.add("disabled")
            positionInput.classList.remove("invalid")
            durationInput.classList.remove("invalid")
            pitchInput.classList.remove("invalid")
            velocityInput.classList.remove("invalid")
            centInput.classList.remove("invalid")
            chanceInput.classList.remove("invalid")
            playCountInput.classList.remove("invalid")
            playCurveInput.classList.remove("invalid")
        } else {
            element.classList.remove("disabled")
            const adapters = selection.selected()
            positionInput.classList.toggle("invalid", !Arrays.satisfy(adapters, (a, b) => a.position === b.position))
            durationInput.classList.toggle("invalid", !Arrays.satisfy(adapters, (a, b) => a.duration === b.duration))
            pitchInput.classList.toggle("invalid", !Arrays.satisfy(adapters, (a, b) => a.pitch === b.pitch))
            velocityInput.classList.toggle("invalid", !Arrays.satisfy(adapters, (a, b) => a.velocity === b.velocity))
            centInput.classList.toggle("invalid", !Arrays.satisfy(adapters, (a, b) => a.cent === b.cent))
            chanceInput.classList.toggle("invalid", !Arrays.satisfy(adapters, (a, b) => a.chance === b.chance))
            playCountInput.classList.toggle("invalid", !Arrays.satisfy(adapters, (a, b) => a.playCount === b.playCount))
            playCurveInput.classList.toggle("invalid", !Arrays.satisfy(adapters, (a, b) => a.playCurve === b.playCurve))

            if (focus !== null) {
                const modifier: Option<NoteModifyStrategies> = modifyContext.modifier
                const strategy = modifier.unwrapOrElse(NoteModifyStrategies.Identity).selectedModifyStrategy()
                ignore = true
                position.parameter.setValue(strategy.readPosition(focus))
                duration.parameter.setValue(strategy.readComplete(focus) - strategy.readPosition(focus))
                pitch.parameter.setValue(strategy.readPitch(focus))
                velocity.parameter.setValue(strategy.readVelocity(focus))
                cent.parameter.setValue(strategy.readCent(focus))
                chance.parameter.setValue(strategy.readChance(focus))
                playCount.parameter.setValue(focus.playCount)
                playCurve.parameter.setValue(focus.playCurve)
                ignore = false
            }
        }
    }))

    let ignore = false
    lifecycle.ownAll(...Object.values(PropertyParameters)
            .map(({parameter, fieldName}) => parameter.subscribe(owner => {
                if (ignore) {return}
                editing.modify(() =>
                    selection.selected()
                        .forEach(adapter => adapter.box[fieldName].setValue(owner.getValue())))
            })),
        selection.catchupAndSubscribe({
            onSelected: (adapter: NoteEventBoxAdapter) => {
                focus = adapter
                updateState.request()
            },
            onDeselected: (adapter: NoteEventBoxAdapter) => {
                if (focus === adapter) {focus = null}
                updateState.request()
            }
        }),
        pitch.parameter.subscribe(owner => pitchString.value = MidiKeys.toFullString(owner.getValue())),
        modifyContext.subscribeUpdate(updateState.request)
    )
    updateState.immediate()
    return element
}