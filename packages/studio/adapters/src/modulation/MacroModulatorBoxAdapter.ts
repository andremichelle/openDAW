import {MacroModulatorBox} from "@opendaw/studio-boxes"
import {ValueMapping} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ModulatorBoxAdapter, polarityStringMapping} from "./ModulatorBoxAdapter"

export class MacroModulatorBoxAdapter extends ModulatorBoxAdapter<MacroModulatorBox> {
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: MacroModulatorBox) {
        super(context, box)
        this.namedParameter = this.#wrapParameters(box)
        this.registerParameterTracks()
    }

    #wrapParameters(box: MacroModulatorBox) {
        return {
            value: this.parametric.createParameter(box.value,
                ValueMapping.unipolar(), polarityStringMapping(box.bipolar), "Value")
        } as const
    }
}
