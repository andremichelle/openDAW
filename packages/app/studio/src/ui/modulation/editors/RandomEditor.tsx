import css from "./RandomEditor.sass?inline"
import {clamp, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {RandomModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ModulatorEditor} from "@/ui/modulation/ModulatorEditor.tsx"
import {RandomDisplay} from "@/ui/modulation/editors/RandomDisplay.tsx"
import {ModulatorKnob} from "@/ui/modulation/ModulatorKnob.tsx"
import {ValueRange} from "@/ui/modulation/ValueRange.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {NumberInput} from "@/ui/components/NumberInput.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"

const className = Html.adoptStyleSheet(css, "RandomEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: RandomModulatorBoxAdapter
}

export const RandomEditor = ({lifecycle, service, modulator}: Construct) => {
    const {editing, liveStreamReceiver} = service.project
    const {rateSync, rateAbsolute, smooth, phase} = modulator.namedParameter
    return (
        <ModulatorEditor lifecycle={lifecycle} service={service} modulator={modulator}>
            <div className={className}>
                <RandomDisplay lifecycle={lifecycle} receiver={liveStreamReceiver} modulator={modulator}/>
                <div className="pattern">
                    <div className="row">
                        <div className="field">
                            <h5>Loop</h5>
                            <NumberInput lifecycle={lifecycle}
                                         guard={{guard: value => clamp(value, 0, RandomModulatorBoxAdapter.MaxLoop)}}
                                         model={EditWrapper.forValue(editing, modulator.box.loop)}/>
                        </div>
                        <div className="field">
                            <h5>Levels</h5>
                            <NumberInput lifecycle={lifecycle}
                                         guard={{guard: value => clamp(value, 0, RandomModulatorBoxAdapter.MaxLevels)}}
                                         model={EditWrapper.forValue(editing, modulator.box.levels)}/>
                        </div>
                    </div>
                    <div className="row">
                        <div className="field">
                            <h5>Seed</h5>
                            <NumberInput lifecycle={lifecycle}
                                         guard={{guard: value => clamp(value, 0, RandomModulatorBoxAdapter.MaxSeed)}}
                                         model={EditWrapper.forValue(editing, modulator.box.seed)}/>
                        </div>
                        <Button lifecycle={lifecycle}
                                onClick={() => editing.modify(() => modulator.reseed())}
                                appearance={{framed: true, color: Colors.orange}}>Reseed</Button>
                    </div>
                </div>
                <div className="knobs">
                    <div className="section"/>
                    {[rateSync, rateAbsolute, smooth, phase].map(parameter => (
                        <ModulatorKnob lifecycle={lifecycle} service={service} parameter={parameter}/>
                    ))}
                    <ValueRange lifecycle={lifecycle} service={service} modulator={modulator}/>
                </div>
            </div>
        </ModulatorEditor>
    )
}
