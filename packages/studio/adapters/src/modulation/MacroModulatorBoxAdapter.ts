import {MacroModulatorBox} from "@opendaw/studio-boxes"
import {StringMapping, ValueMapping} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ModulatorBoxAdapter} from "./ModulatorBoxAdapter"

export class MacroModulatorBoxAdapter extends ModulatorBoxAdapter<MacroModulatorBox> {
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: MacroModulatorBox) {
        super(context, box)
        this.namedParameter = this.#wrapParameters(box)
    }

    #wrapParameters(box: MacroModulatorBox) {
        return {
            value: this.parametric.createParameter(box.value,
                ValueMapping.unipolar(), StringMapping.percent({fractionDigits: 0}), "Value")
        } as const
    }
}
