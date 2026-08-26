import {DefaultObservableValue, DefaultParameter, Option, Parameter, RuntimeNotifier, StringMapping, Terminator, ValueMapping} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {AudioUnitBoxAdapter} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {RevampDeviceBox} from "@opendaw/studio-boxes"
import {AutoEq, EffectFactories, OfflineEngineRenderer} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Dialog} from "@/ui/components/Dialog"
import {Knob} from "@/ui/components/Knob"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {Surface} from "@/ui/surface/Surface"

const INVERSE_SQRT_2 = Math.SQRT1_2
const TILT_MIN = -3.0 // darker (roll off the highs)
const TILT_MAX = 3.0 // brighter (lift the highs)
const STRENGTH_MIN = 3.0 // max dB a single section may move: gentle
const STRENGTH_MAX = 12.0 // ... up to aggressive

export namespace AutoEqAction {
    const LABEL = "Auto-EQ"

    export const run = async (service: StudioService, outputUnit: AudioUnitBoxAdapter): Promise<void> => {
        const settings = await requestSettings(service)
        if (settings.isEmpty()) {return}
        const {project} = service
        const existing = findExisting(outputUnit)
        // Render a copy with any prior Auto-EQ disabled, so we always measure the RAW mix. Re-runs then
        // replace this device's settings instead of stacking a second correction on top of the first.
        const source = project.copy()
        existing.ifSome(box => source.boxGraph.findBox(box.address.uuid).ifSome(vertex =>
            source.editing.modify(() => (vertex.box as RevampDeviceBox).enabled.setValue(false))))
        const progress = new DefaultObservableValue(0.0)
        const abortController = new AbortController()
        const handler = RuntimeNotifier.progress({
            headline: "Auto-EQ", progress, cancel: () => abortController.abort()
        })
        const rendered = await Promises.tryCatch(
            OfflineEngineRenderer.start(source, Option.None, progress, abortController.signal))
        handler.terminate()
        if (rendered.status === "rejected") {
            RuntimeNotifier.notify({message: "Auto-EQ was cancelled or failed to render.", icon: "Info"})
            return
        }
        const result = AutoEq.analyze(rendered.value, settings.unwrap())
        const field = outputUnit.audioEffectsField.unwrap("output has no audio-effect host")
        project.editing.modify(() => {
            // Corrective EQ must sit at the FRONT of the master chain, before any Maximizer/limiter: placed
            // after it, the EQ's boosts push the already-ceilinged signal past 0 dBFS and clip.
            const box = existing.unwrapOrElse(() =>
                project.api.insertEffect(field, EffectFactories.Revamp, 0) as RevampDeviceBox)
            project.api.moveEffects(field, [box], 0)
            apply(box, result)
        })
    }

    const findExisting = (outputUnit: AudioUnitBoxAdapter): Option<RevampDeviceBox> => {
        const collection = outputUnit.audioEffects
        if (collection.isEmpty()) {return Option.None}
        for (const adapter of collection.unwrap().adapters()) {
            const box = adapter.box
            if (box instanceof RevampDeviceBox && box.label.getValue() === LABEL) {return Option.wrap(box)}
        }
        return Option.None
    }

    const apply = (box: RevampDeviceBox, result: AutoEq.Result): void => {
        box.label.setValue(LABEL)
        box.enabled.setValue(true)
        box.highPass.enabled.setValue(false)
        box.lowPass.enabled.setValue(false)
        box.lowShelf.enabled.setValue(true)
        box.lowShelf.frequency.setValue(result.lowShelf.frequency)
        box.lowShelf.gain.setValue(result.lowShelf.gainDb)
        box.highShelf.enabled.setValue(true)
        box.highShelf.frequency.setValue(result.highShelf.frequency)
        box.highShelf.gain.setValue(result.highShelf.gainDb)
        for (const [bell, band] of [
            [box.lowBell, result.lowBell], [box.midBell, result.midBell], [box.highBell, result.highBell]
        ] as const) {
            bell.enabled.setValue(true)
            bell.frequency.setValue(band.frequency)
            bell.gain.setValue(band.gainDb)
            bell.q.setValue(INVERSE_SQRT_2)
        }
    }

    const requestSettings = (service: StudioService): Promise<Option<AutoEq.Options>> => {
        const lifecycle = new Terminator()
        const {resolve, promise} = Promise.withResolvers<Option<AutoEq.Options>>()
        const strengthParam: Parameter<number> = lifecycle.own(new DefaultParameter(
            ValueMapping.linear(STRENGTH_MIN, STRENGTH_MAX),
            StringMapping.numeric({unit: " dB", fractionDigits: 1}),
            "Strength", AutoEq.DEFAULT_MAX_GAIN_DB))
        const tiltParam: Parameter<number> = lifecycle.own(new DefaultParameter(
            ValueMapping.linear(TILT_MIN, TILT_MAX),
            StringMapping.numeric({unit: " dB/oct", fractionDigits: 1}),
            "Tilt", AutoEq.DEFAULT_TILT_DB_PER_OCTAVE))
        const knobRow = (parameter: Parameter<number>, caption: string, anchor: number): HTMLElement => {
            const valueLabel: HTMLElement = (<span className="value"/>)
            const update = () => {
                const printValue = parameter.getPrintValue()
                valueLabel.textContent = `${printValue.value}${printValue.unit}`
            }
            lifecycle.own(parameter.subscribe(update))
            update()
            return (
                <div style={{display: "flex", alignItems: "center", columnGap: "0.75em"}}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={service.project.editing}
                                               parameter={parameter}>
                        <Knob lifecycle={lifecycle} value={parameter} anchor={anchor} color={Colors.blue}/>
                    </RelativeUnitValueDragging>
                    <span style={{color: Colors.dark.toString(), minWidth: "5em"}}>{caption}</span>
                    {valueLabel}
                </div>
            )
        }
        const strengthAnchor = (AutoEq.DEFAULT_MAX_GAIN_DB - STRENGTH_MIN) / (STRENGTH_MAX - STRENGTH_MIN)
        const tiltAnchor = (AutoEq.DEFAULT_TILT_DB_PER_OCTAVE - TILT_MIN) / (TILT_MAX - TILT_MIN)
        const dialog: HTMLDialogElement = (
            <Dialog headline="Auto-EQ"
                    icon={IconSymbol.EQ}
                    cancelable={true}
                    buttons={[
                        {text: "Cancel", onClick: handler => {handler.close(); resolve(Option.None)}},
                        {text: "Analyze", primary: true, onClick: handler => {
                            handler.close()
                            resolve(Option.wrap({
                                tiltDbPerOctave: tiltParam.getValue(),
                                maxGainDb: strengthParam.getValue()
                            }))
                        }}
                    ]}>
                <div style={{padding: "1em 0", maxWidth: "26em", display: "flex", flexDirection: "column", rowGap: "1em"}}>
                    <p style={{whiteSpace: "pre-line"}}>
                        Renders the whole project once, measures its tonal balance, and appends a Revamp EQ to
                        the output that levels resonances and dips toward a reference. Strength caps how far each
                        section may move (gentle by default); Tilt brightens (+) or darkens (-) the result. The
                        result is a normal Revamp you can inspect and tweak.
                    </p>
                    {knobRow(strengthParam, "Strength", strengthAnchor)}
                    {knobRow(tiltParam, "Tilt", tiltAnchor)}
                </div>
            </Dialog>
        )
        dialog.addEventListener("close", () => {resolve(Option.None); lifecycle.terminate()})
        Surface.get().body.appendChild(dialog)
        dialog.showModal()
        return promise
    }
}
