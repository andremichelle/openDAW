import {int, isDefined, Nullable, Optional, tryCatch} from "@opendaw/lib-std"
import {ScriptDeclaration} from "./ScriptDeclaration"

type Token = {
    readonly kind: "word" | "punct" | "literal"
    readonly text: string
    readonly offset: int
    readonly lineStart: boolean
}

const REGEX_KEYWORDS: ReadonlyArray<string> = [
    "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"
]
const MODIFIERS: ReadonlyArray<string> = ["static", "async", "get", "set"]
const CONTINUATIONS: ReadonlyArray<string> = ["=", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "!", "?", ":", ",", ".", "(", "[", "~"]
const IDENTIFIER = /[\p{ID_Start}$_#][\p{ID_Continue}$‌‍]*/uy
const NUMBER = /\.?\d[\w.]*/y

const regexAllowedAfter = (previous: Optional<Token>): boolean => {
    if (!isDefined(previous)) {return true}
    if (previous.kind === "literal") {return false}
    if (previous.kind === "word") {return REGEX_KEYWORDS.includes(previous.text)}
    return previous.text !== ")" && previous.text !== "]" && previous.text !== "}"
}

const tokenize = (code: string): ReadonlyArray<Token> => {
    const tokens: Array<Token> = []
    const templateDepths: Array<int> = []
    let index = 0
    let braceDepth = 0
    let lineStart = true
    const push = (kind: Token["kind"], text: string, offset: int): void => {
        tokens.push({kind, text, offset, lineStart})
        lineStart = false
    }
    const scanTemplateChunk = (): void => {
        const start = index
        while (index < code.length) {
            const char = code[index]
            if (char === "\\") {
                index += 2
            } else if (char === "`") {
                index++
                break
            } else if (char === "$" && code[index + 1] === "{") {
                index += 2
                templateDepths.push(braceDepth)
                break
            } else {
                index++
            }
        }
        push("literal", code.slice(start, index), start)
    }
    while (index < code.length) {
        const char = code[index]
        if (char === " " || char === "\t" || char === "\n" || char === "\r") {
            if (char === "\n") {lineStart = true}
            index++
            continue
        }
        if (char === "/" && code[index + 1] === "/") {
            const end = code.indexOf("\n", index)
            index = end === -1 ? code.length : end
            continue
        }
        if (char === "/" && code[index + 1] === "*") {
            const end = code.indexOf("*/", index + 2)
            const stop = end === -1 ? code.length : end + 2
            if (code.slice(index, stop).includes("\n")) {lineStart = true}
            index = stop
            continue
        }
        if (char === "\"" || char === "'") {
            const start = index++
            while (index < code.length && code[index] !== char && code[index] !== "\n") {
                index += code[index] === "\\" ? 2 : 1
            }
            index++
            push("literal", code.slice(start, index), start)
            continue
        }
        if (char === "`") {
            index++
            scanTemplateChunk()
            continue
        }
        if (char === "/" && regexAllowedAfter(tokens.at(-1))) {
            const start = index++
            let inClass = false
            while (index < code.length && code[index] !== "\n") {
                const current = code[index]
                if (current === "\\") {
                    index += 2
                    continue
                }
                if (current === "[") {inClass = true}
                if (current === "]") {inClass = false}
                index++
                if (current === "/" && !inClass) {break}
            }
            while (index < code.length && /[a-z]/i.test(code[index])) {index++}
            push("literal", code.slice(start, index), start)
            continue
        }
        if (char === "}" && templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braceDepth) {
            templateDepths.pop()
            index++
            scanTemplateChunk()
            continue
        }
        IDENTIFIER.lastIndex = index
        const identifier = IDENTIFIER.exec(code)
        if (identifier !== null) {
            push("word", identifier[0], index)
            index += identifier[0].length
            continue
        }
        NUMBER.lastIndex = index
        const number = NUMBER.exec(code)
        if (number !== null) {
            push("literal", number[0], index)
            index += number[0].length
            continue
        }
        if (char === "{") {braceDepth++}
        if (char === "}") {braceDepth--}
        push("punct", char, index)
        index++
    }
    return tokens
}

const isPunct = (token: Optional<Token>, text: string): boolean =>
    isDefined(token) && token.kind === "punct" && token.text === text

const isMemberBoundary = (previous: Optional<Token>, token: Token): boolean => {
    if (!isDefined(previous)) {return false}
    if (previous.kind === "word" && MODIFIERS.includes(previous.text)) {return true}
    if (previous.kind === "punct" && ["{", "}", ";", "*"].includes(previous.text)) {return true}
    if (!token.lineStart) {return false}
    if (previous.kind === "punct") {return !CONTINUATIONS.includes(previous.text)}
    return previous.kind === "literal" || !REGEX_KEYWORDS.includes(previous.text)
}

const closingParenthesis = (tokens: ReadonlyArray<Token>, open: int): int => {
    let depth = 0
    for (let index = open; index < tokens.length; index++) {
        if (isPunct(tokens[index], "(")) {depth++}
        if (isPunct(tokens[index], ")") && --depth === 0) {return index}
    }
    return -1
}

const closingBrace = (tokens: ReadonlyArray<Token>, open: int): int => {
    let depth = 0
    for (let index = open; index < tokens.length; index++) {
        if (isPunct(tokens[index], "{")) {depth++}
        if (isPunct(tokens[index], "}") && --depth === 0) {return index}
    }
    return tokens.length
}

// token index ranges [start, end) between `from` and `to`, split at commas outside nested brackets
const splitTopLevel = (tokens: ReadonlyArray<Token>, from: int, to: int): ReadonlyArray<[int, int]> => {
    const ranges: Array<[int, int]> = []
    let depth = 0
    let start = from
    for (let index = from; index < to; index++) {
        const token = tokens[index]
        if (token.kind !== "punct") {continue}
        if (token.text === "{" || token.text === "(" || token.text === "[") {depth++}
        if (token.text === "}" || token.text === ")" || token.text === "]") {depth--}
        if (token.text === "," && depth === 0) {
            if (index > start) {ranges.push([start, index])}
            start = index + 1
        }
    }
    if (to > start) {ranges.push([start, to])}
    return ranges
}

const editDistance = (left: string, right: string): int => {
    const row = Array.from({length: right.length + 1}, (unused, index) => index)
    for (let indexLeft = 1; indexLeft <= left.length; indexLeft++) {
        let diagonal = row[0]
        row[0] = indexLeft
        for (let indexRight = 1; indexRight <= right.length; indexRight++) {
            const above = row[indexRight]
            row[indexRight] = Math.min(row[indexRight] + 1, row[indexRight - 1] + 1,
                diagonal + (left[indexLeft - 1] === right[indexRight - 1] ? 0 : 1))
            diagonal = above
        }
    }
    return row[right.length]
}

export namespace ScriptEntryPoints {
    export type Entry = {
        readonly name: string
        readonly signature: string
        readonly documentation: string
    }

    // `fields` document `param.field` and `{field}` destructuring, `elements` document `param[index]` and `[a, b]`
    export type Parameter = Entry & { readonly fields: ReadonlyArray<Entry>, readonly elements: ReadonlyArray<Entry> }

    export type Method = Entry & { readonly generator: boolean, readonly parameters: ReadonlyArray<Parameter> }

    // `keys`: which declaration names `this.<property>.<key>` must match
    export type Property = Entry & { readonly keys: Nullable<"sample" | "sidechain"> }

    export type Api = {
        readonly className: string
        readonly methods: ReadonlyArray<Method>
        readonly properties: ReadonlyArray<Property>
        readonly globals: ReadonlyArray<Entry>
    }

    export type Member = {
        readonly name: string
        readonly generator: boolean
        readonly isStatic: boolean
        readonly offset: int
    }

    export type Access = {
        readonly name: string
        readonly offset: int
        readonly key: Nullable<{ readonly name: string, readonly offset: int }>
    }

    export type Finding = {
        readonly type: "known" | "argument" | "near-miss" | "generator-mismatch" | "static" | "undeclared"
        readonly name: string
        readonly offset: int
        readonly entry: Entry
        readonly warning: Nullable<string>
    }

    type ScannedMember = Member & { readonly open: int, readonly close: int, readonly bodyEnd: int }

    type ClassScan = { readonly members: ReadonlyArray<ScannedMember>, readonly accesses: ReadonlyArray<Access> }

    const scan = (tokens: ReadonlyArray<Token>, className: string): ClassScan => {
        const classIndex = tokens.findIndex((token, index) => token.kind === "word" && token.text === "class"
            && tokens[index + 1]?.kind === "word" && tokens[index + 1].text === className)
        if (classIndex === -1) {return {members: [], accesses: []}}
        const bodyStart = tokens.findIndex((token, index) => index > classIndex && isPunct(token, "{"))
        if (bodyStart === -1) {return {members: [], accesses: []}}
        const members: Array<ScannedMember> = []
        const accesses: Array<Access> = []
        let depth = 1
        for (let index = bodyStart + 1; index < tokens.length && depth > 0; index++) {
            const token = tokens[index]
            if (token.kind === "punct") {
                if (token.text === "{" || token.text === "(" || token.text === "[") {depth++}
                if (token.text === "}" || token.text === ")" || token.text === "]") {depth--}
                continue
            }
            if (token.kind === "word" && token.text === "this" && isPunct(tokens[index + 1], ".")
                && tokens[index + 2]?.kind === "word") {
                const property = tokens[index + 2]
                const key = isPunct(tokens[index + 3], ".") && tokens[index + 4]?.kind === "word" ? tokens[index + 4] : null
                accesses.push({
                    name: property.text, offset: property.offset,
                    key: isDefined(key) ? {name: key.text, offset: key.offset} : null
                })
                continue
            }
            if (depth !== 1 || token.kind !== "word" || !isPunct(tokens[index + 1], "(")) {continue}
            if (!isMemberBoundary(tokens[index - 1], token)) {continue}
            const close = closingParenthesis(tokens, index + 1)
            if (close === -1 || !isPunct(tokens[close + 1], "{")) {continue}
            let cursor = index - 1
            let generator = false
            let isStatic = false
            while (cursor > bodyStart && (isPunct(tokens[cursor], "*")
                || (tokens[cursor].kind === "word" && MODIFIERS.includes(tokens[cursor].text)))) {
                if (isPunct(tokens[cursor], "*")) {generator = true}
                if (tokens[cursor].text === "static") {isStatic = true}
                cursor--
            }
            members.push({
                name: token.text, generator, isStatic, offset: token.offset,
                open: index + 1, close, bodyEnd: closingBrace(tokens, close + 1)
            })
        }
        return {members, accesses}
    }

    export const scanClass = (code: string, className: string): ReadonlyArray<Member> =>
        scan(tokenize(code), className).members

    export const scanAccesses = (code: string, className: string): ReadonlyArray<Access> =>
        scan(tokenize(code), className).accesses

    export const findNearMiss = (name: string, methods: ReadonlyArray<Method>): Nullable<Method> => {
        if (methods.some(method => method.name === name)) {return null}
        const lower = name.toLowerCase()
        const sameCase = methods.find(method => method.name.toLowerCase() === lower)
        if (isDefined(sameCase)) {return sameCase}
        const typos = methods.filter(method => method.name.length > 5 && editDistance(name, method.name) === 1)
        return typos.find(method => method.name.startsWith(name) || name.startsWith(method.name)) ?? typos.at(0) ?? null
    }

    const declaredKeys = (code: string, keys: "sample" | "sidechain"): Nullable<ReadonlyArray<string>> => {
        const result = tryCatch(() => keys === "sample" ? ScriptDeclaration.parseSamples(code) : ScriptDeclaration.parseSidechains(code))
        return result.status === "success" ? result.value.map(({label}) => label) : null
    }

    const methodFindings = (members: ReadonlyArray<Member>, methods: ReadonlyArray<Method>): ReadonlyArray<Finding> =>
        members.filter(member => !member.name.startsWith("#")).flatMap((member): ReadonlyArray<Finding> => {
            const {name, offset} = member
            const method = methods.find(candidate => candidate.name === name)
            if (isDefined(method)) {
                if (member.isStatic) {
                    return [{type: "static", name, offset, entry: method,
                        warning: `'${name}' is called on the instance, remove 'static'`}]
                }
                if (member.generator !== method.generator) {
                    return [{type: "generator-mismatch", name, offset, entry: method,
                        warning: method.generator ? `'${name}' must be a generator: ${method.signature}`
                            : `'${name}' must not be a generator, remove the '*'`}]
                }
                return [{type: "known", name, offset, entry: method, warning: null}]
            }
            const nearMiss = findNearMiss(name, methods)
            return isDefined(nearMiss)
                ? [{type: "near-miss", name, offset, entry: nearMiss,
                    warning: `'${name}' is never called by the device. Did you mean '${nearMiss.name}'?`}]
                : []
        })

    const accessFindings = (code: string, accesses: ReadonlyArray<Access>,
                            properties: ReadonlyArray<Property>): ReadonlyArray<Finding> =>
        accesses.flatMap((access): ReadonlyArray<Finding> => {
            const property = properties.find(candidate => candidate.name === access.name)
            if (!isDefined(property)) {return []}
            const known: Finding = {type: "known", name: access.name, offset: access.offset, entry: property, warning: null}
            if (!isDefined(property.keys) || !isDefined(access.key)) {return [known]}
            const declared = declaredKeys(code, property.keys)
            if (!isDefined(declared) || declared.includes(access.key.name)) {return [known]}
            const list = declared.length === 0 ? "none" : declared.join(", ")
            return [known, {
                type: "undeclared", name: access.key.name, offset: access.key.offset, entry: property,
                warning: `No '// @${property.keys} ${access.key.name}' declared (declared: ${list})`
            }]
        })

    const argumentFindings = (tokens: ReadonlyArray<Token>, member: ScannedMember, method: Method): ReadonlyArray<Finding> => {
        const findings: Array<Finding> = []
        const parameters = new Map<string, Parameter>()
        const locals = new Map<string, Entry>()
        const add = (token: Token, entry: Entry): void => {
            findings.push({type: "argument", name: token.text, offset: token.offset, entry, warning: null})
        }
        splitTopLevel(tokens, member.open + 1, member.close).forEach(([start, end], position) => {
            const parameter = method.parameters.at(position)
            if (!isDefined(parameter)) {return}
            const first = tokens[start]
            if (first.kind === "word") {
                parameters.set(first.text, parameter)
                add(first, parameter)
            } else if (isPunct(first, "{")) {
                for (const [entryStart] of splitTopLevel(tokens, start + 1, end - 1)) {
                    const key = tokens[entryStart]
                    const field = parameter.fields.find(candidate => candidate.name === key.text)
                    if (key.kind !== "word" || !isDefined(field)) {continue}
                    add(key, field)
                    const alias = isPunct(tokens[entryStart + 1], ":") && tokens[entryStart + 2]?.kind === "word"
                        ? tokens[entryStart + 2] : null
                    if (isDefined(alias)) {add(alias, field)}
                    locals.set((alias ?? key).text, field)
                }
            } else if (isPunct(first, "[")) {
                splitTopLevel(tokens, start + 1, end - 1).forEach(([elementStart], index) => {
                    const element = parameter.elements.at(index)
                    const token = tokens[elementStart]
                    if (token.kind !== "word" || !isDefined(element)) {return}
                    add(token, element)
                    locals.set(token.text, element)
                })
            }
        })
        for (let index = member.close + 2; index < member.bodyEnd; index++) {
            const token = tokens[index]
            if (token.kind !== "word" || isPunct(tokens[index - 1], ".")) {continue}
            const parameter = parameters.get(token.text)
            if (isDefined(parameter)) {
                add(token, parameter)
                const next = tokens[index + 2]
                if (isPunct(tokens[index + 1], ".") && next?.kind === "word") {
                    const field = parameter.fields.find(candidate => candidate.name === next.text)
                    if (isDefined(field)) {add(next, field)}
                } else if (isPunct(tokens[index + 1], "[") && next?.kind === "literal" && isPunct(tokens[index + 3], "]")) {
                    const element = parameter.elements.at(Number(next.text))
                    if (isDefined(element)) {add(next, element)}
                }
                continue
            }
            const local = locals.get(token.text)
            if (isDefined(local)) {add(token, local)}
        }
        return findings
    }

    const globalFindings = (tokens: ReadonlyArray<Token>, globals: ReadonlyArray<Entry>): ReadonlyArray<Finding> =>
        tokens.flatMap((token, index): ReadonlyArray<Finding> => {
            if (token.kind !== "word" || isPunct(tokens[index - 1], ".")) {return []}
            const entry = globals.find(candidate => candidate.name === token.text)
            return isDefined(entry) ? [{type: "known", name: token.text, offset: token.offset, entry, warning: null}] : []
        })

    export const analyse = (code: string, api: Api): ReadonlyArray<Finding> => {
        const tokens = tokenize(code)
        const {members, accesses} = scan(tokens, api.className)
        const argumentsOfMethods = members.flatMap(member => {
            const method = api.methods.find(candidate => candidate.name === member.name)
            return isDefined(method) && !member.isStatic ? argumentFindings(tokens, member, method) : []
        })
        return [
            ...methodFindings(members, api.methods),
            ...argumentsOfMethods,
            ...accessFindings(code, accesses, api.properties),
            ...globalFindings(tokens, api.globals)
        ].sort((left, right) => left.offset - right.offset)
    }
}
