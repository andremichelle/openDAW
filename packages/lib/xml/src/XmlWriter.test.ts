// @vitest-environment node
import {describe, expect, it} from "vitest"
import {XmlNode} from "./XmlNode"
import {XmlReader} from "./XmlReader"
import {XmlWriter} from "./XmlWriter"

const node = (name: string, attributes: Record<string, string> = {}, children: ReadonlyArray<XmlNode> = [],
              text: string = ""): XmlNode => ({name, attributes: new Map(Object.entries(attributes)), children, text})

describe("XmlWriter", () => {
    it("writes declaration, indentation, self-closing and text elements", () => {
        const xml = XmlWriter.write(node("a", {x: "1"}, [node("b"), node("c", {}, [node("d")]), node("e", {}, [], "text")]))
        expect(xml).toBe([
            XmlWriter.Declaration,
            "<a x=\"1\">",
            "  <b/>",
            "  <c>",
            "    <d/>",
            "  </c>",
            "  <e>text</e>",
            "</a>"
        ].join("\n"))
    })
    it("omits the declaration on request", () => {
        expect(XmlWriter.write(node("a"), {declaration: false})).toBe("<a/>")
    })
    it("escapes text and attributes so that they read back identical", () => {
        const special = "<tag> & \"quoted\" 'single'\n\tline\r 🎹 ]]>"
        const xml = XmlWriter.write(node("a", {v: special}, [], special))
        const read = XmlReader.parse(xml)
        expect(read.attributes.get("v")).toBe(special)
        expect(read.text).toBe(special)
    })
    it("replaces characters XML 1.0 cannot carry", () => {
        const xml = XmlWriter.write(node("a", {v: "a\u0001b\uD800c"}, [], "\u0000"), {declaration: false})
        expect(xml).toBe("<a v=\"a�b�c\">�</a>")
        expect(() => XmlReader.parse(xml)).not.toThrow()
    })
    it("keeps valid surrogate pairs", () => {
        expect(XmlWriter.escapeText("\u{1F600}")).toBe("\u{1F600}")
    })
})
