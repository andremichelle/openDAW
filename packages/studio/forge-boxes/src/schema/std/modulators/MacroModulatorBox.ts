import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {UnipolarConstraints} from "../Defaults"
import {ModulatorFactory} from "./ModulatorFactory"

export const MacroModulatorBox: BoxSchema<Pointers> = ModulatorFactory.createModulator("MacroModulatorBox", {
    10: {type: "float32", name: "value", value: 0.0, ...UnipolarConstraints}
})
