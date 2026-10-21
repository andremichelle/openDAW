import {int, isDefined, Nullable, Optional, tryCatch} from "@opendaw/lib-std"
import {ScriptDeclaration} from "./ScriptDeclaration"
import {ScriptTokenizer} from "./ScriptTokenizer"

type Token = ScriptTokenizer.Token

const {
    closingBrace, closingParenthesis, CONTINUATIONS, isPunct, MODIFIERS, REGEX_KEYWORDS, splitTopLevel, tokenize
} = ScriptTokenizer

const isMemberBoundary = (previous: Optional<Token>, token: Token): boolean => {
    if (!isDefined(previous)) {return false}
    if (previous.kind === "word" && MODIFIERS.includes(previous.text)) {return true}
    if (previous.kind === "punct" && ["{", "}", ";", "*"].includes(previous.text)) {return true}
    if (!token.lineStart) {return false}
    if (previous.kind === "punct") {return !CONTINUATIONS.includes(previous.text)}
    return previous.kind === "literal" || !REGEX_KEYWORDS.includes(previous.text)
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
    export type Property = Entry & { readonly keys: Nullable<"sample" | "sidechain" | "collection"> }

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

    const declaredKeys = (code: string, keys: "sample" | "sidechain" | "collection"): Nullable<ReadonlyArray<string>> => {
        const result = tryCatch(() => keys === "sample" ? ScriptDeclaration.parseSamples(code).map(({label}) => label)
            : keys === "sidechain" ? ScriptDeclaration.parseSidechains(code).map(({label}) => label)
                : ScriptDeclaration.parseCollections(code).map(({name}) => name))
        return result.status === "success" ? result.value : null
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
