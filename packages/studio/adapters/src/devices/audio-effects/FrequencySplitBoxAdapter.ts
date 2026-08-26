import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {FrequencySplitBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {AudioCompositeAdapter} from "./AudioEffectComposite/AudioCompositeAdapter"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AutomatableParameterFieldAdapter} from "../../AutomatableParameterFieldAdapter"

const CrossoverMapping = ValueMapping.exponential(20.0, 20_000.0)
const CrossoverString = StringMapping.numeric({unit: "Hz", fractionDigits: 0})

export class FrequencySplitBoxAdapter extends AudioCompositeAdapter {
    static readonly MAX_BANDS = 4

    readonly #crossoverParametric: ParameterAdapterSet
    readonly crossover: ReadonlyArray<AutomatableParameterFieldAdapter<number>>

    constructor(context: BoxAdaptersContext, box: FrequencySplitBox) {
        super(context, box)
        this.#crossoverParametric = new ParameterAdapterSet(context)
        this.crossover = [
            this.#crossoverParametric.createParameter(box.crossover1, CrossoverMapping, CrossoverString, "Crossover 1"),
            this.#crossoverParametric.createParameter(box.crossover2, CrossoverMapping, CrossoverString, "Crossover 2"),
            this.#crossoverParametric.createParameter(box.crossover3, CrossoverMapping, CrossoverString, "Crossover 3")
        ]
    }

    get crossoverCount(): number {return Math.max(0, this.entries.adapters().length - 1)}

    get spectrum(): Address {return this.address.append(0xFFF)}

    get entriesFixed(): boolean {return true}
    get manualUrl(): string {return DeviceManualUrls.FrequencySplit}
}
