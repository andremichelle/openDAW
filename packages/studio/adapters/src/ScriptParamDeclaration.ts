import {asInstanceOf, isDefined, Nullable, StringMapping, Terminable, ValueMapping} from "@opendaw/lib-std"
import {Field, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {WerkstattParameterBox} from "@opendaw/studio-boxes"
import {ParameterAdapterSet} from "./ParameterAdapterSet"

export type ParamMapping = "unipolar" | "linear" | "exp" | "int" | "bool"

export interface ParamDeclaration {
    readonly label: string
    readonly defaultValue: number
    readonly min: number
    readonly max: number
    readonly mapping: ParamMapping
    readonly unit: string
}

export interface SampleDeclaration {
    readonly label: string
}

const PARAM_LINE = /^\/\/ @param .+$/gm
const SAMPLE_LINE = /^\/\/ @sample .+$/gm
const DECLARATION_LINE = /^\/\/ @(?:param|sample) \S+/gm
const FLOAT_TOLERANCE = 1e-6
const VALID_MAPPINGS: ReadonlyArray<string> = ["linear", "exp", "int", "bool"]

const BoolStringMapping: StringMapping<number> = new class implements StringMapping<number> {
    x(y: number): { value: string, unit: string } {
        return {value: y >= 0.5 ? "On" : "Off", unit: ""}
    }
    y(x: string): { type: "explicit", value: number } {
        const lower = x.trim().toLowerCase()
        return {type: "explicit", value: (lower === "on" || lower === "true" || lower === "yes") ? 1 : 0}
    }
}

const parseSingleParam = (line: string): ParamDeclaration => {
    const tokens = line.replace(/^\/\/ @param\s+/, "").split(/\s+/)
    if (tokens.length === 0) {
        throw new Error(`Malformed @param: '${line}'`)
    }
    const label = tokens[0]
    if (tokens.length === 1) {
        return {label, defaultValue: 0, min: 0, max: 1, mapping: "unipolar", unit: ""}
    }
    const second = tokens[1]
    if (second === "true" || second === "false") {
        return {label, defaultValue: second === "true" ? 1 : 0, min: 0, max: 1, mapping: "bool", unit: ""}
    }
    if (second === "bool") {
        return {label, defaultValue: 0, min: 0, max: 1, mapping: "bool", unit: ""}
    }
    const defaultValue = parseFloat(second)
    if (isNaN(defaultValue)) {
        throw new Error(`Malformed @param: '${line}' — '${second}' is not a valid number`)
    }
    if (tokens.length === 2) {
        return {label, defaultValue, min: 0, max: 1, mapping: "unipolar", unit: ""}
    }
    if (tokens.length === 3 && tokens[2] === "bool") {
        return {label, defaultValue: defaultValue >= 0.5 ? 1 : 0, min: 0, max: 1, mapping: "bool", unit: ""}
    }
    if (tokens.length === 4) {
        const min = parseFloat(tokens[2])
        const max = parseFloat(tokens[3])
        if (isNaN(min) || isNaN(max)) {
            throw new Error(`Malformed @param: '${line}' — min/max must be numbers`)
        }
        if (max - min < -FLOAT_TOLERANCE) {
            throw new Error(`Malformed @param: '${line}' — min (${min}) must be less than max (${max})`)
        }
        if (defaultValue < min - FLOAT_TOLERANCE || defaultValue > max + FLOAT_TOLERANCE) {
            throw new Error(`Malformed @param: '${line}' — default (${defaultValue}) must be within [${min}, ${max}]`)
        }
        return {label, defaultValue, min, max, mapping: "linear", unit: ""}
    }
    if (tokens.length < 5) {
        throw new Error(`Malformed @param: '${line}' — expected: // @param <name> <default> <min> <max> [type] [unit]`)
    }
    const min = parseFloat(tokens[2])
    const max = parseFloat(tokens[3])
    const mapping = tokens[4] as ParamMapping
    const unit = tokens.length >= 6 ? tokens[5] : ""
    if (isNaN(min) || isNaN(max)) {
        throw new Error(`Malformed @param: '${line}' — min/max must be numbers`)
    }
    if (!VALID_MAPPINGS.includes(mapping)) {
        throw new Error(`Malformed @param: '${line}' — unknown mapping '${mapping}' (expected: linear, exp, int, bool)`)
    }
    if (max - min < -FLOAT_TOLERANCE) {
        throw new Error(`Malformed @param: '${line}' — min (${min}) must be less than max (${max})`)
    }
    if (defaultValue < min - FLOAT_TOLERANCE || defaultValue > max + FLOAT_TOLERANCE) {
        throw new Error(`Malformed @param: '${line}' — default (${defaultValue}) must be within [${min}, ${max}]`)
    }
    return {label, defaultValue, min, max, mapping, unit}
}

const declarationEquals = (a: ParamDeclaration, b: ParamDeclaration): boolean =>
    a.mapping === b.mapping && a.min === b.min && a.max === b.max && a.unit === b.unit

export namespace ScriptParamDeclaration {
    export const parseParams = (code: string): ReadonlyArray<ParamDeclaration> => {
        const params: Array<ParamDeclaration> = []
        let match: Nullable<RegExpExecArray>
        PARAM_LINE.lastIndex = 0
        while ((match = PARAM_LINE.exec(code)) !== null) {
            params.push(parseSingleParam(match[0]))
        }
        return params
    }

    export const parseSamples = (code: string): ReadonlyArray<SampleDeclaration> => {
        const samples: Array<SampleDeclaration> = []
        let match: Nullable<RegExpExecArray>
        SAMPLE_LINE.lastIndex = 0
        while ((match = SAMPLE_LINE.exec(code)) !== null) {
            const tokens = match[0].replace(/^\/\/ @sample\s+/, "").split(/\s+/)
            if (tokens.length === 0 || tokens[0].length === 0) {
                throw new Error(`Malformed @sample: '${match[0]}' — expected: // @sample <name>`)
            }
            if (tokens.length > 1) {
                throw new Error(`Malformed @sample: '${match[0]}' — expected: // @sample <name>`)
            }
            samples.push({label: tokens[0]})
        }
        return samples
    }

    export const parseDeclarationOrder = (code: string): Map<string, number> => {
        const order = new Map<string, number>()
        let match: Nullable<RegExpExecArray>
        DECLARATION_LINE.lastIndex = 0
        let index = 0
        while ((match = DECLARATION_LINE.exec(code)) !== null) {
            const label = match[0].replace(/^\/\/ @(?:param|sample)\s+/, "").split(/\s+/)[0]
            if (!order.has(label)) {
                order.set(label, index++)
            }
        }
        return order
    }

    export const resolveValueMapping = (declaration: ParamDeclaration): ValueMapping<number> => {
        switch (declaration.mapping) {
            case "unipolar":
                return ValueMapping.unipolar()
            case "linear":
                return ValueMapping.linear(declaration.min, declaration.max)
            case "exp":
                return ValueMapping.exponential(declaration.min, declaration.max)
            case "int":
                return ValueMapping.linearInteger(declaration.min, declaration.max) as ValueMapping<number>
            case "bool":
                return ValueMapping.linearInteger(0, 1) as ValueMapping<number>
        }
    }

    export const resolveStringMapping = (declaration: ParamDeclaration): StringMapping<number> => {
        switch (declaration.mapping) {
            case "unipolar":
                return StringMapping.percent()
            case "linear":
                return StringMapping.numeric({unit: declaration.unit, fractionDigits: 2})
            case "exp":
                return StringMapping.numeric({unit: declaration.unit, fractionDigits: 2})
            case "int":
                return StringMapping.numeric({unit: declaration.unit, fractionDigits: 0})
            case "bool":
                return BoolStringMapping
        }
    }

    type ParamMapping = {
        valueMapping: ValueMapping<number>
        stringMapping: StringMapping<number>
    }

    export const resolveParamMappings = (declaration: ParamDeclaration): ParamMapping => ({
        valueMapping: resolveValueMapping(declaration),
        stringMapping: resolveStringMapping(declaration)
    })

    export const subscribeScriptParams = (parametric: ParameterAdapterSet,
                                          codeField: StringField,
                                          parametersField: Field<Pointers.Parameter>): Terminable => {
        const cachedDeclarations = new Map<string, ParamDeclaration>()
        return Terminable.many(
            parametersField.pointerHub.catchupAndSubscribe({
                onAdded: (({box: parameterBox}) => {
                    const paramBox = asInstanceOf(parameterBox, WerkstattParameterBox)
                    const label = paramBox.label.getValue()
                    const declarations = parseParams(codeField.getValue())
                    const declaration = declarations.find(decl => decl.label === label)
                    const {valueMapping, stringMapping} = isDefined(declaration)
                        ? resolveParamMappings(declaration)
                        : {
                            valueMapping: ValueMapping.unipolar(),
                            stringMapping: StringMapping.percent({fractionDigits: 1})
                        }
                    parametric.createParameter(paramBox.value, valueMapping, stringMapping, label)
                    if (isDefined(declaration)) {cachedDeclarations.set(label, declaration)}
                }),
                onRemoved: (({box}) => {
                    const paramBox = asInstanceOf(box, WerkstattParameterBox)
                    cachedDeclarations.delete(paramBox.label.getValue())
                    parametric.removeParameter(paramBox.value.address)
                })
            }),
            codeField.subscribe(() => {
                const declarations = parseParams(codeField.getValue())
                for (const adapter of parametric.parameters()) {
                    const newDeclaration = declarations.find(decl => decl.label === adapter.name)
                    if (!isDefined(newDeclaration)) {continue}
                    const oldDeclaration = cachedDeclarations.get(adapter.name)
                    if (isDefined(oldDeclaration) && declarationEquals(oldDeclaration, newDeclaration)) {continue}
                    const {valueMapping, stringMapping} = resolveParamMappings(newDeclaration)
                    adapter.updateMappings(valueMapping, stringMapping)
                    cachedDeclarations.set(adapter.name, newDeclaration)
                }
            })
        )
    }
}
