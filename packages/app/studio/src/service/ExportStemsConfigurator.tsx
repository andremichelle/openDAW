import css from "./ExportStemsConfigurator.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement, Frag} from "@moises-ai/lib-jsx"
import {Checkbox} from "@/ui/components/Checkbox"
import {DefaultObservableValue, Lifecycle} from "@moises-ai/lib-std"
import {ColorCodes, ExportStemsConfiguration} from "@moises-ai/studio-adapters"
import {AudioUnitType, Colors, IconSymbol} from "@moises-ai/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {TextInput} from "@/ui/components/TextInput"

const className = Html.adoptStyleSheet(css, "ExportStemsConfigurator")

export type EditableExportStemsConfiguration = ExportStemsConfiguration & Record<string, {
    readonly type: AudioUnitType
    label: string
    include: boolean
}>

type Construct = {
    lifecycle: Lifecycle
    configuration: EditableExportStemsConfiguration
}

export const ExportStemsConfigurator = ({lifecycle, configuration}: Construct) => {
    const includeAll = new DefaultObservableValue(true)
    const includeAudioEffectsAll = new DefaultObservableValue(true)
    const includeSendsAll = new DefaultObservableValue(true)
    return (
        <div className={className}>
            <header>
                <div>Name</div>
                <Checkbox lifecycle={lifecycle}
                          model={includeAll}
                          appearance={{activeColor: Colors.cream, cursor: "pointer"}}>
                    <span style={{color: Colors.gray.toString()}}>Export</span>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle}
                          model={includeAudioEffectsAll}
                          appearance={{activeColor: Colors.blue, cursor: "pointer"}}>
                    <span style={{color: Colors.gray.toString()}}>Audio FX</span>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle}
                          model={includeSendsAll}
                          appearance={{activeColor: ColorCodes.forAudioType(AudioUnitType.Aux), cursor: "pointer"}}>
                    <span style={{color: Colors.gray.toString()}}>Send FX</span>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
                <div>File Name</div>
            </header>
            <div className="list">
                {Object.values(configuration).map((stem) => {
                    const include = new DefaultObservableValue(stem.include)
                    const includeAudioEffects = new DefaultObservableValue(stem.includeAudioEffects)
                    const includeSends = new DefaultObservableValue(stem.includeSends)
                    const fileName = new DefaultObservableValue(ExportStemsConfiguration.sanitizeFileName(stem.label))
                    lifecycle.ownAll(
                        include.subscribe(owner => stem.include = owner.getValue()),
                        includeAudioEffects.subscribe(owner => stem.includeAudioEffects = owner.getValue()),
                        includeSends.subscribe(owner => stem.includeSends = owner.getValue()),
                        fileName.subscribe(owner => stem.fileName = owner.getValue()),
                        includeAll.subscribe(owner => include.setValue(owner.getValue())),
                        includeAudioEffectsAll.subscribe(owner => includeAudioEffects.setValue(owner.getValue())),
                        includeSendsAll.subscribe(owner => includeSends.setValue(owner.getValue()))
                    )
                    return (
                        <Frag>
                            <div className="name"
                                 style={{color: ColorCodes.forAudioType(stem.type).toString()}}>{stem.label}</div>
                            <Checkbox lifecycle={lifecycle}
                                      model={include}
                                      appearance={{activeColor: Colors.cream}}>
                                <Icon symbol={IconSymbol.Checkbox}/>
                            </Checkbox>
                            <Checkbox lifecycle={lifecycle}
                                      model={includeAudioEffects}
                                      appearance={{activeColor: Colors.blue}}>
                                <Icon symbol={IconSymbol.Checkbox}/>
                            </Checkbox>
                            {stem.type === AudioUnitType.Output ? <div/> : (
                                <Checkbox lifecycle={lifecycle}
                                          model={includeSends}
                                          appearance={{activeColor: ColorCodes.forAudioType(AudioUnitType.Aux)}}>
                                    <Icon symbol={IconSymbol.Checkbox}/>
                                </Checkbox>
                            )}
                            <TextInput lifecycle={lifecycle} model={fileName}/>
                        </Frag>
                    )
                })}
            </div>
        </div>
    )
}