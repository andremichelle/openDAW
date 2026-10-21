import {
    asInstanceOf,
    isDefined,
    Notifier,
    Nullable,
    Observable,
    Option,
    StringMapping,
    Strings,
    Terminable,
    ValueMapping
} from "@opendaw/lib-std"
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

export interface SidechainDeclaration {
    readonly label: string
}

// `// @view [Class] <column> <row> <columns> <rows>`, cells are 1-based and relative to the view's section
export interface ViewDeclaration {
    readonly className: string
    readonly column: number
    readonly row: number
    readonly columns: number
    readonly rows: number
}

// `// @window [Class] <width> <height>`, size in CSS pixels
export interface WindowDeclaration {
    readonly className: string
    readonly width: number
    readonly height: number
}

export interface GroupDeclaration {
    readonly label: string
    readonly color: string
}

export type DeclarationItem =
    | { readonly type: "param", readonly declaration: ParamDeclaration }
    | { readonly type: "sample", readonly declaration: SampleDeclaration }
    | { readonly type: "sidechain", readonly declaration: SidechainDeclaration }
    | { readonly type: "view", readonly declaration: ViewDeclaration }

export interface DeclarationSection {
    readonly group: Nullable<GroupDeclaration>
    readonly items: ReadonlyArray<DeclarationItem>
}

const LABEL_LINE = /^\/\/ @label .+$/m
const PARAM_LINE = /^\/\/ @param .+$/gm
const SAMPLE_LINE = /^\/\/ @sample .+$/gm
const SIDECHAIN_LINE = /^\/\/ @sidechain .+$/gm
const GROUP_LINE = /^\/\/ @group .+$/gm
const DIRECTIVE_LINE = /^\/\/ @(group|param|sample|sidechain|view) .+$/gm
const VIEW_LINE = /^\/\/ @view\b.*$/gm
const WINDOW_LINE = /^\/\/ @window\b.*$/gm
const CLASS_NAME = /^[A-Za-z_$][\w$]*$/
const DEFAULT_VIEW_CLASS = "View"
const DECLARATION_LINE = /^\/\/ @(?:param|sample) \S+/gm
const NO_PASS_LINE = /^\/\/ @no-pass\b(.*)$/m
const LATENCY_LINE = /^\/\/ @latency\b(.*)$/m
const FLOAT_TOLERANCE = 1e-6
const VALID_MAPPINGS: ReadonlyArray<string> = ["linear", "exp", "int", "bool"]

const RESERVED_NAMES: ReadonlyArray<string> = ["__proto__"]

const checkName = (label: string, line: string): string => {
    if (RESERVED_NAMES.includes(label)) {throw new Error(`Reserved name '${label}' in '${line}' — choose another name`)}
    return label
}

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
    const tokens = line.replace(/^\/\/ @param\s+/, "").replace(/\s+\/\/.*$/, "").trim().split(/\s+/)
    if (tokens.length === 0) {
        throw new Error(`Malformed @param: '${line}'`)
    }
    const label = checkName(tokens[0], line)
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
        if (max - min < FLOAT_TOLERANCE) {
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
    if (mapping !== "bool" && max - min < FLOAT_TOLERANCE) {
        throw new Error(`Malformed @param: '${line}' — min (${min}) must be less than max (${max})`)
    }
    if (defaultValue < min - FLOAT_TOLERANCE || defaultValue > max + FLOAT_TOLERANCE) {
        throw new Error(`Malformed @param: '${line}' — default (${defaultValue}) must be within [${min}, ${max}]`)
    }
    return {label, defaultValue, min, max, mapping, unit}
}

const parseSingleSidechain = (line: string): SidechainDeclaration => {
    const tokens = line.replace(/^\/\/ @sidechain\s+/, "").replace(/\s+\/\/.*$/, "").trim().split(/\s+/)
    if (tokens.length !== 1 || tokens[0].length === 0) {
        throw new Error(`Malformed @sidechain: '${line}' — expected: // @sidechain <name>`)
    }
    return {label: checkName(tokens[0], line)}
}

// optional class name, then `count` positive integers
const parseClassAndIntegers = (line: string, tag: string, count: number, usage: string): [string, ReadonlyArray<number>] => {
    const tokens = line.replace(new RegExp(`^\\/\\/ @${tag}\\s*`), "").replace(/\s+\/\/.*$/, "").trim().split(/\s+/)
        .filter(token => token.length > 0)
    const named = tokens.length > 0 && !/^\d/.test(tokens[0])
    const className = named ? tokens[0] : DEFAULT_VIEW_CLASS
    const numbers = named ? tokens.slice(1) : tokens
    if (!CLASS_NAME.test(className)) {throw new Error(`Malformed @${tag}: '${line}' — '${className}' is not a class name`)}
    checkName(className, line)
    if (numbers.length !== count || numbers.some(token => !/^\d+$/.test(token) || parseInt(token) < 1)) {
        throw new Error(`Malformed @${tag}: '${line}' — expected: ${usage}`)
    }
    return [className, numbers.map(token => parseInt(token))]
}

const parseSingleView = (line: string): ViewDeclaration => {
    const [className, [column, row, columns, rows]] =
        parseClassAndIntegers(line, "view", 4, "// @view [Class] <column> <row> <columns> <rows>")
    return {className, column, row, columns, rows}
}

const parseSingleWindow = (line: string): WindowDeclaration => {
    const [className, [width, height]] = parseClassAndIntegers(line, "window", 2, "// @window [Class] <width> <height>")
    return {className, width, height}
}

const declarationEquals = (a: ParamDeclaration, b: ParamDeclaration): boolean =>
    a.mapping === b.mapping && a.min === b.min && a.max === b.max && a.unit === b.unit

const declarationFullEquals = (a: ParamDeclaration, b: ParamDeclaration): boolean =>
    declarationEquals(a, b) && Math.abs(a.defaultValue - b.defaultValue) < 1e-6

export namespace ScriptDeclaration {
    export const isEqual = declarationFullEquals

    export const parseLabel = (code: string): Option<string> => {
        const match = LABEL_LINE.exec(code)
        if (match === null) {return Option.None}
        const label = match[0].replace(/^\/\/ @label\s+/, "").trim()
        if (label.length === 0) {throw new Error("Malformed @label: expected: // @label <name>")}
        return Option.wrap(label)
    }

    // A note transformer forwards its input VERBATIM unless the script opts out with `// @no-pass`, so a device
    // with no (or a broken) script never eats the note stream.
    export const parsePassThrough = (code: string): boolean => {
        const match = NO_PASS_LINE.exec(code)
        if (match === null) {return true}
        if (match[1].trim().length > 0) {throw new Error("Malformed @no-pass: expected: // @no-pass")}
        return false
    }

    // `// @latency <ms>`: the delay the processor adds to its output, which delay compensation aligns
    export const parseLatency = (code: string): number => {
        const match = LATENCY_LINE.exec(code)
        if (match === null) {return 0}
        const text = match[1].replace(/\s+\/\/.*$/, "").trim()
        const value = Number(text)
        if (text.length === 0 || !Number.isFinite(value) || value < 0) {
            throw new Error(`Malformed @latency: '${match[0]}' — expected: // @latency <milliseconds>`)
        }
        return value
    }

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
            const tokens = match[0].replace(/^\/\/ @sample\s+/, "").replace(/\s+\/\/.*$/, "").trim().split(/\s+/)
            if (tokens.length === 0 || tokens[0].length === 0) {
                throw new Error(`Malformed @sample: '${match[0]}' — expected: // @sample <name>`)
            }
            if (tokens.length > 1) {
                throw new Error(`Malformed @sample: '${match[0]}' — expected: // @sample <name>`)
            }
            samples.push({label: checkName(tokens[0], match[0])})
        }
        return samples
    }

    export const parseSidechains = (code: string): ReadonlyArray<SidechainDeclaration> => {
        const sidechains: Array<SidechainDeclaration> = []
        let match: Nullable<RegExpExecArray>
        SIDECHAIN_LINE.lastIndex = 0
        while ((match = SIDECHAIN_LINE.exec(code)) !== null) {
            const declaration = parseSingleSidechain(match[0])
            if (!sidechains.some(other => other.label === declaration.label)) {sidechains.push(declaration)}
        }
        return sidechains
    }

    export const parseViews = (code: string): ReadonlyArray<ViewDeclaration> =>
        Array.from(code.matchAll(VIEW_LINE), match => parseSingleView(match[0]))

    export const parseWindows = (code: string): ReadonlyArray<WindowDeclaration> =>
        Array.from(code.matchAll(WINDOW_LINE), match => parseSingleWindow(match[0]))

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

    export const parseGroups = (code: string): ReadonlyArray<DeclarationSection> => {
        const sections: Array<DeclarationSection> = []
        let currentGroup: Nullable<GroupDeclaration> = null
        let currentItems: Array<DeclarationItem> = []
        DIRECTIVE_LINE.lastIndex = 0
        let match: Nullable<RegExpExecArray>
        while ((match = DIRECTIVE_LINE.exec(code)) !== null) {
            const line = match[0]
            const type = match[1]
            if (type === "group") {
                if (currentItems.length > 0 || currentGroup !== null) {
                    sections.push({group: currentGroup, items: currentItems})
                }
                const tokens = line.replace(/^\/\/ @group\s+/, "").trim().split(/\s+/)
                currentGroup = {label: tokens[0], color: tokens[1] ?? "dark"}
                currentItems = []
            } else if (type === "param") {
                currentItems.push({type: "param", declaration: parseSingleParam(line)})
            } else if (type === "sample") {
                const tokens = line.replace(/^\/\/ @sample\s+/, "").replace(/\s+\/\/.*$/, "").trim().split(/\s+/)
                if (tokens.length === 0 || tokens[0].length === 0) {
                    throw new Error(`Malformed @sample: '${line}' — expected: // @sample <name>`)
                }
                currentItems.push({type: "sample", declaration: {label: checkName(tokens[0], line)}})
            } else if (type === "sidechain") {
                currentItems.push({type: "sidechain", declaration: parseSingleSidechain(line)})
            } else if (type === "view") {
                currentItems.push({type: "view", declaration: parseSingleView(line)})
            }
        }
        if (currentItems.length > 0 || currentGroup !== null) {
            sections.push({group: currentGroup, items: currentItems})
        }
        return sections
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

    export type ScriptParamsBinding = {
        readonly terminable: Terminable
        readonly codeChanged: Observable<void>
    }

    export const subscribeScriptParams = (parametric: ParameterAdapterSet,
                                          codeField: StringField,
                                          parametersField: Field<Pointers.Parameter>): ScriptParamsBinding => {
        const cachedDeclarations = new Map<string, ParamDeclaration>()
        const codeChangedNotifier = new Notifier<void>()
        const terminable = Terminable.many(
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
                    // Script authors write `@param` names in any case they like. The stored label stays verbatim
                    // (ScriptCompiler keys parameter boxes by it), only the displayed name is normalised.
                    parametric.createParameter(paramBox.value, valueMapping, stringMapping, Strings.capitalize(label),
                        undefined, paramBox.defaultValue.getValue())
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
                    const newDeclaration = declarations.find(decl => Strings.capitalize(decl.label) === adapter.name)
                    if (!isDefined(newDeclaration)) {continue}
                    const oldDeclaration = cachedDeclarations.get(newDeclaration.label)
                    if (isDefined(oldDeclaration) && declarationEquals(oldDeclaration, newDeclaration)) {continue}
                    const {valueMapping, stringMapping} = resolveParamMappings(newDeclaration)
                    adapter.updateMappings(valueMapping, stringMapping)
                    cachedDeclarations.set(newDeclaration.label, newDeclaration)
                }
                codeChangedNotifier.notify()
            }),
            codeChangedNotifier
        )
        return {terminable, codeChanged: codeChangedNotifier}
    }
}