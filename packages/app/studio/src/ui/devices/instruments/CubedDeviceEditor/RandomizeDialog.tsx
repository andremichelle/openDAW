import css from "./RandomizeDialog.sass?inline"
import {clamp, DefaultObservableValue, int, Procedure, StringMapping, Terminator, unitValue} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {MidiKeys} from "@opendaw/lib-dsp"
import {CubedContour, CubedRandomize, CubedRandomizeOptions} from "@opendaw/studio-adapters"
import {Dialog} from "@/ui/components/Dialog"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {NumberInput} from "@/ui/components/NumberInput"
import {Checkbox} from "@/ui/components/Checkbox"
import {DropDown} from "@/ui/composite/DropDown"
import {Icon} from "@/ui/components/Icon"
import {Colors, IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "CubedRandomizeDialog")

const Percent = StringMapping.percent({fractionDigits: 0})
const ContourLabels: Record<CubedContour, string> = {
    free: "Free", walk: "Walk", rise: "Rise", fall: "Fall"
}

export const showRandomizeDialog = (options: CubedRandomizeOptions,
                                    randomize: Procedure<CubedRandomizeOptions>,
                                    commit: Procedure<CubedRandomizeOptions>): void => {
    const lifecycle = new Terminator()
    const root = lifecycle.own(new DefaultObservableValue<int>(options.root))
    const scale = lifecycle.own(new DefaultObservableValue<MidiKeys.PredefinedScale>(options.scale))
    const octave = lifecycle.own(new DefaultObservableValue<int>(options.octave))
    const octaves = lifecycle.own(new DefaultObservableValue<int>(options.octaves))
    const density = lifecycle.own(new DefaultObservableValue<unitValue>(options.density))
    const accent = lifecycle.own(new DefaultObservableValue<unitValue>(options.accent))
    const slide = lifecycle.own(new DefaultObservableValue<unitValue>(options.slide))
    const motif = lifecycle.own(new DefaultObservableValue<int>(options.motif))
    const contour = lifecycle.own(new DefaultObservableValue<CubedContour>(options.contour))
    const rootFirst = lifecycle.own(new DefaultObservableValue<boolean>(options.rootFirst))
    const percentInput = (model: DefaultObservableValue<unitValue>) => (
        <div className="percent">
            <NumberInput lifecycle={lifecycle} model={model} mapper={Percent} step={0.05}
                         guard={{guard: value => clamp(Math.round(value * 100) / 100, 0.0, 1.0)}}/>
            <span className="unit">%</span>
        </div>
    )
    const collect = (): CubedRandomizeOptions => ({
        root: root.getValue(),
        scale: scale.getValue(),
        octave: octave.getValue(),
        octaves: octaves.getValue(),
        density: density.getValue(),
        accent: accent.getValue(),
        slide: slide.getValue(),
        motif: motif.getValue(),
        contour: contour.getValue(),
        rootFirst: rootFirst.getValue()
    })
    const dialog: HTMLDialogElement = (
        <Dialog headline="Randomize Pattern"
                icon={IconSymbol.Flask}
                cancelable={true}
                buttons={[{
                    text: "Randomize",
                    onClick: () => randomize(collect())
                }, {
                    text: "Ok",
                    primary: true,
                    onClick: handler => {
                        commit(collect())
                        handler.close()
                    }
                }]}>
            <div className={className}>
                <span>Root</span>
                <div className="wide">
                    <RadioGroup lifecycle={lifecycle} model={root}
                                elements={MidiKeys.Names.English.map((name, value) => ({
                                    value, element: <span>{name}</span>
                                }))}/>
                </div>
                <span>Scale</span>
                <div className="scale">
                    <DropDown lifecycle={lifecycle} owner={scale} width="7.5em"
                              provider={() => MidiKeys.StockScales} mapping={scale => scale.name}/>
                </div>
                <span>Contour</span>
                <RadioGroup lifecycle={lifecycle} model={contour}
                            elements={CubedRandomize.Contours.map(value => ({
                                value, element: <span>{ContourLabels[value]}</span>
                            }))}/>
                <span>Octave</span>
                <NumberInput lifecycle={lifecycle} model={octave}
                             guard={{guard: value => clamp(Math.round(value), 0, 7)}}/>
                <span>Spanning</span>
                <NumberInput lifecycle={lifecycle} model={octaves}
                             guard={{guard: value => clamp(Math.round(value), 1, 4)}}/>
                <span>Motif</span>
                <RadioGroup lifecycle={lifecycle} model={motif}
                            elements={CubedRandomize.Motifs.map(value => ({
                                value, element: <span>{value === 0 ? "Off" : String(value)}</span>
                            }))}/>
                <span>Density</span>
                {percentInput(density)}
                <span>Accent</span>
                {percentInput(accent)}
                <span>Slide</span>
                {percentInput(slide)}
                <span>Start on tonic</span>
                <Checkbox lifecycle={lifecycle} model={rootFirst}
                          appearance={{color: Colors.shadow, activeColor: Colors.orange, framed: true}}>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
            </div>
        </Dialog>
    )
    document.body.appendChild(dialog)
    dialog.addEventListener("close", () => lifecycle.terminate(), {once: true})
    dialog.showModal()
}
