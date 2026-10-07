import {asInstanceOf, StringMapping, Terminable, Terminator, ValueMapping} from "@opendaw/lib-std"
import {Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {WclapParameterBox} from "@opendaw/studio-boxes"
import {ParameterAdapterSet} from "../ParameterAdapterSet"

const IS_STEPPED = 1 << 0 // CLAP_PARAM_IS_STEPPED

// Keeps a parameter adapter per `WclapParameterBox` child of a WebCLAP device, shared by the effect and instrument
export namespace WclapParameterAdapters {
    export const subscribe = (parametric: ParameterAdapterSet, parameters: Field<Pointers.Parameter>): Terminable => {
        const ranges = new Terminator()
        return Terminable.many(ranges, parameters.pointerHub.catchupAndSubscribe({
            onAdded: ({box}) => {
                const paramBox = asInstanceOf(box, WclapParameterBox)
                const {valueMapping, stringMapping} = mappings(paramBox)
                const adapter = parametric.createParameter(paramBox.value, valueMapping, stringMapping,
                    paramBox.label.getValue(), undefined, paramBox.defaultValue.getValue())
                const update = () => {
                    const {valueMapping, stringMapping} = mappings(paramBox)
                    adapter.updateMappings(valueMapping, stringMapping)
                }
                ranges.ownAll(paramBox.min.subscribe(update), paramBox.max.subscribe(update), paramBox.flags.subscribe(update))
            },
            onRemoved: ({box}) => parametric.removeParameter(asInstanceOf(box, WclapParameterBox).value.address)
        }))
    }

    const mappings = (paramBox: WclapParameterBox): { valueMapping: ValueMapping<number>, stringMapping: StringMapping<number> } => {
        const min = paramBox.min.getValue()
        const max = paramBox.max.getValue()
        const stepped = (paramBox.flags.getValue() & IS_STEPPED) !== 0
        return {
            valueMapping: stepped ? ValueMapping.linearInteger(min, max) : ValueMapping.linear(min, max),
            stringMapping: StringMapping.numeric({unit: "", fractionDigits: stepped ? 0 : 2})
        }
    }
}
