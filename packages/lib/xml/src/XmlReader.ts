import {int, isDefined, Optional, panic} from "@opendaw/lib-std"
import {XmlNode} from "./XmlNode"

export namespace XmlReader {
    const PredefinedEntities: ReadonlyMap<string, string> = new Map([
        ["lt", "<"], ["gt", ">"], ["amp", "&"], ["quot", "\""], ["apos", "'"]
    ])

    const isWhitespace = (code: int): boolean => code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D

    const isNameStart = (code: int): boolean =>
        (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A) || code === 0x5F || code === 0x3A || code >= 0x80

    const isNameChar = (code: int): boolean =>
        isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2D || code === 0x2E

    export const parse = (input: string): XmlNode => {
        const source = input.replace(/\r\n?/g, "\n")
        const cursor = {index: source.charCodeAt(0) === 0xFEFF ? 1 : 0}
        const fail = (message: string): never => {
            const before = source.substring(0, cursor.index)
            const line = before.split("\n").length
            const column = cursor.index - before.lastIndexOf("\n")
            return panic(`XML ${message} (line ${line}, column ${column})`)
        }
        const startsWith = (text: string): boolean => source.startsWith(text, cursor.index)
        const expect = (text: string): void => {
            if (!startsWith(text)) {fail(`expected '${text}'`)}
            cursor.index += text.length
        }
        const skipUntil = (terminator: string): void => {
            const end = source.indexOf(terminator, cursor.index)
            if (end === -1) {fail(`missing '${terminator}'`)}
            cursor.index = end + terminator.length
        }
        const skipWhitespace = (): void => {
            while (cursor.index < source.length && isWhitespace(source.charCodeAt(cursor.index))) {cursor.index++}
        }
        const skipDoctype = (): void => {
            cursor.index += 9
            const depth = {value: 0}
            while (cursor.index < source.length) {
                const char = source[cursor.index++]
                if (char === "[") {depth.value++} else if (char === "]") {depth.value--} else if (char === ">" && depth.value === 0) {return}
            }
            fail("unterminated DOCTYPE")
        }
        const skipMisc = (): void => {
            while (true) {
                skipWhitespace()
                if (startsWith("<!--")) {skipUntil("-->")} else if (startsWith("<?")) {skipUntil("?>")} else if (startsWith("<!DOCTYPE")) {skipDoctype()} else {return}
            }
        }
        const readName = (): string => {
            const start = cursor.index
            if (!isNameStart(source.charCodeAt(cursor.index))) {fail("expected a name")}
            while (cursor.index < source.length && isNameChar(source.charCodeAt(cursor.index))) {cursor.index++}
            return source.substring(start, cursor.index)
        }
        const readReference = (): string => {
            const end = source.indexOf(";", cursor.index)
            if (end === -1 || end - cursor.index > 12) {fail("unterminated entity reference")}
            const reference = source.substring(cursor.index + 1, end)
            const resolved = reference.startsWith("#") ? fromCodePoint(reference) : PredefinedEntities.get(reference)
            if (!isDefined(resolved)) {return fail(`unknown entity '&${reference};'`)}
            cursor.index = end + 1
            return resolved
        }
        const fromCodePoint = (reference: string): Optional<string> => {
            const hex = reference.startsWith("#x")
            const digits = reference.substring(hex ? 2 : 1)
            if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {return undefined}
            const code = parseInt(digits, hex ? 16 : 10)
            return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : undefined
        }
        const readCharacterData = (terminator: string, normalizeWhitespace: boolean): string => {
            const parts: Array<string> = []
            const start = {value: cursor.index}
            while (cursor.index < source.length && source[cursor.index] !== terminator) {
                const char = source[cursor.index]
                if (char === "&") {
                    parts.push(source.substring(start.value, cursor.index))
                    parts.push(readReference())
                    start.value = cursor.index
                } else if (char === "<") {
                    fail("unexpected '<'")
                } else if (normalizeWhitespace && (char === "\n" || char === "\t")) {
                    parts.push(source.substring(start.value, cursor.index), " ")
                    start.value = ++cursor.index
                } else {
                    cursor.index++
                }
            }
            parts.push(source.substring(start.value, cursor.index))
            return parts.join("")
        }
        const readAttributes = (): Map<string, string> => {
            const attributes = new Map<string, string>()
            while (true) {
                const before = cursor.index
                skipWhitespace()
                if (startsWith("/>") || startsWith(">")) {return attributes}
                if (before === cursor.index) {fail("expected whitespace before attribute")}
                const name = readName()
                skipWhitespace()
                expect("=")
                skipWhitespace()
                const quote = source[cursor.index]
                if (quote !== "\"" && quote !== "'") {fail("expected a quoted attribute value")}
                cursor.index++
                const value = readCharacterData(quote, true)
                if (cursor.index >= source.length) {fail("unterminated attribute value")}
                cursor.index++
                if (attributes.has(name)) {fail(`duplicate attribute '${name}'`)}
                attributes.set(name, value)
            }
        }
        const readElement = (): XmlNode => {
            expect("<")
            const name = readName()
            const attributes = readAttributes()
            if (startsWith("/>")) {
                cursor.index += 2
                return {name, attributes, children: [], text: ""}
            }
            expect(">")
            const children: Array<XmlNode> = []
            const text: Array<string> = []
            while (true) {
                if (cursor.index >= source.length) {fail(`unclosed element <${name}>`)}
                if (startsWith("</")) {
                    cursor.index += 2
                    const closing = readName()
                    if (closing !== name) {fail(`expected </${name}> but found </${closing}>`)}
                    skipWhitespace()
                    expect(">")
                    const joined = text.join("")
                    return {name, attributes, children, text: children.length > 0 && joined.trim().length === 0 ? "" : joined}
                } else if (startsWith("<![CDATA[")) {
                    const end = source.indexOf("]]>", cursor.index)
                    if (end === -1) {fail("unterminated CDATA section")}
                    text.push(source.substring(cursor.index + 9, end))
                    cursor.index = end + 3
                } else if (startsWith("<!--")) {
                    skipUntil("-->")
                } else if (startsWith("<?")) {
                    skipUntil("?>")
                } else if (startsWith("<")) {
                    children.push(readElement())
                } else {
                    text.push(readCharacterData("<", false))
                }
            }
        }
        skipMisc()
        if (!startsWith("<")) {fail("expected a root element")}
        const root = readElement()
        skipMisc()
        if (cursor.index < source.length) {fail("unexpected content after the root element")}
        return root
    }
}
