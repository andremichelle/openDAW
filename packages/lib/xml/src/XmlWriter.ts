import {XmlNode} from "./XmlNode"

export namespace XmlWriter {
    export const Declaration = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"

    export interface Options {
        readonly declaration?: boolean
        readonly indent?: string
    }

    const IllegalCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

    export const escapeText = (text: string): string => text
        .replace(IllegalCharacters, "�")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\r/g, "&#13;")

    export const escapeAttribute = (text: string): string => escapeText(text)
        .replace(/"/g, "&quot;")
        .replace(/\t/g, "&#9;")
        .replace(/\n/g, "&#10;")

    export const write = (root: XmlNode, options?: Options): string => {
        const indent = options?.indent ?? "  "
        const lines: Array<string> = []
        if (options?.declaration ?? true) {lines.push(Declaration)}
        const openTag = (node: XmlNode): string => {
            const attributes = Array.from(node.attributes, ([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
            return `<${node.name}${attributes.join("")}`
        }
        const inline = (node: XmlNode): string => {
            if (node.children.length === 0 && node.text.length === 0) {return `${openTag(node)}/>`}
            return `${openTag(node)}>${escapeText(node.text)}${node.children.map(inline).join("")}</${node.name}>`
        }
        const visit = (node: XmlNode, depth: number): void => {
            const padding = indent.repeat(depth)
            if (node.children.length === 0 || node.text.length > 0) {
                lines.push(padding + inline(node))
                return
            }
            lines.push(`${padding}${openTag(node)}>`)
            node.children.forEach(child => visit(child, depth + 1))
            lines.push(`${padding}</${node.name}>`)
        }
        visit(root, 0)
        return lines.join("\n")
    }
}
