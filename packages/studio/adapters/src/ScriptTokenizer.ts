import {int, isDefined, Optional} from "@opendaw/lib-std"

export namespace ScriptTokenizer {
    export type Token = {
        readonly kind: "word" | "punct" | "literal"
        readonly text: string
        readonly offset: int
        readonly lineStart: boolean
    }

    export const REGEX_KEYWORDS: ReadonlyArray<string> = [
        "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"
    ]
    export const MODIFIERS: ReadonlyArray<string> = ["static", "async", "get", "set"]
    export const CONTINUATIONS: ReadonlyArray<string> = ["=", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "!", "?", ":", ",", ".", "(", "[", "~"]
    const IDENTIFIER = /[\p{ID_Start}$_#][\p{ID_Continue}$\u200c\u200d]*/uy
    const NUMBER = /\.?\d[\w.]*/y

    const regexAllowedAfter = (previous: Optional<Token>): boolean => {
        if (!isDefined(previous)) {return true}
        if (previous.kind === "literal") {return false}
        if (previous.kind === "word") {return REGEX_KEYWORDS.includes(previous.text)}
        return previous.text !== ")" && previous.text !== "]" && previous.text !== "}"
    }

    export const tokenize = (code: string): ReadonlyArray<Token> => {
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

    export const isPunct = (token: Optional<Token>, text: string): boolean =>
        isDefined(token) && token.kind === "punct" && token.text === text

    export const closingParenthesis = (tokens: ReadonlyArray<Token>, open: int): int => {
        let depth = 0
        for (let index = open; index < tokens.length; index++) {
            if (isPunct(tokens[index], "(")) {depth++}
            if (isPunct(tokens[index], ")") && --depth === 0) {return index}
        }
        return -1
    }

    export const closingBrace = (tokens: ReadonlyArray<Token>, open: int): int => {
        let depth = 0
        for (let index = open; index < tokens.length; index++) {
            if (isPunct(tokens[index], "{")) {depth++}
            if (isPunct(tokens[index], "}") && --depth === 0) {return index}
        }
        return tokens.length
    }

    // token index ranges [start, end) between `from` and `to`, split at commas outside nested brackets
    export const splitTopLevel = (tokens: ReadonlyArray<Token>, from: int, to: int): ReadonlyArray<[int, int]> => {
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
}
