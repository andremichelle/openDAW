// @vitest-environment node
import {describe, expect, it} from "vitest"
import {XmlReader} from "./XmlReader"

describe("XmlReader", () => {
    it("parses declaration, comments, PIs, doctype and BOM", () => {
        const node = XmlReader.parse("﻿<?xml version=\"1.0\"?>\n<!-- c --><!DOCTYPE a [<!ELEMENT a ANY>]><?pi x?><a/><!-- after -->\n")
        expect(node.name).toBe("a")
        expect(node.children).toHaveLength(0)
    })
    it("parses attributes with both quote styles", () => {
        const node = XmlReader.parse(`<a x="1" y='two' z = "3"/>`)
        expect(Array.from(node.attributes)).toEqual([["x", "1"], ["y", "two"], ["z", "3"]])
    })
    it("decodes entities and character references", () => {
        const node = XmlReader.parse(`<a v="&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#x1F600;">x &amp; y &#10;</a>`)
        expect(node.attributes.get("v")).toBe("<>&\"'AB\u{1F600}")
        expect(node.text).toBe("x & y \n")
    })
    it("normalizes literal whitespace in attributes but keeps character references", () => {
        const node = XmlReader.parse("<a v=\"a\tb\nc\r\nd&#10;e&#9;f\"/>")
        expect(node.attributes.get("v")).toBe("a b c d\ne\tf")
    })
    it("normalizes line endings in text", () => {
        expect(XmlReader.parse("<a>1\r\n2\r3</a>").text).toBe("1\n2\n3")
    })
    it("reads CDATA as raw text", () => {
        expect(XmlReader.parse("<a><![CDATA[<b>&amp;</b>]]></a>").text).toBe("<b>&amp;</b>")
    })
    it("keeps element order and nesting", () => {
        const node = XmlReader.parse("<a><b><c/></b><d/>text<e>t</e></a>")
        expect(node.children.map(child => child.name)).toEqual(["b", "d", "e"])
        expect(node.children[0].children[0].name).toBe("c")
        expect(node.children[2].text).toBe("t")
        expect(node.text).toBe("text")
    })
    it("accepts names with namespaces, dots and dashes", () => {
        const node = XmlReader.parse(`<x:a xmlns:x="u" a.b-c="1"><x:b/></x:a>`)
        expect(node.name).toBe("x:a")
        expect(node.attributes.get("a.b-c")).toBe("1")
    })
    it("accepts unicode text and names", () => {
        const node = XmlReader.parse("<ä name=\"Ünïcødé 🎹\">日本語</ä>")
        expect(node.name).toBe("ä")
        expect(node.attributes.get("name")).toBe("Ünïcødé 🎹")
        expect(node.text).toBe("日本語")
    })
    it.each([
        ["", "expected a root element"],
        ["text", "expected a root element"],
        ["<a>", "unclosed element <a>"],
        ["<a></b>", "expected </a> but found </b>"],
        ["<a x=1/>", "expected a quoted attribute value"],
        ["<a x=\"1\" x=\"2\"/>", "duplicate attribute 'x'"],
        ["<a x=\"1\"y=\"2\"/>", "expected whitespace before attribute"],
        ["<a x=\"<\"/>", "unexpected '<'"],
        ["<a>&foo;</a>", "unknown entity '&foo;'"],
        ["<a>&#xZZ;</a>", "unknown entity '&#xZZ;'"],
        ["<a>&#0;</a>", "unknown entity '&#0;'"],
        ["<a>&amp</a>", "unterminated entity reference"],
        ["<a/><b/>", "unexpected content after the root element"],
        ["<a><!-- open</a>", "missing '-->'"],
        ["<a><![CDATA[x</a>", "unterminated CDATA section"],
        ["<a x=\"1", "unterminated attribute value"]
    ])("rejects malformed input %j", (input, message) => {
        expect(() => XmlReader.parse(input)).toThrow(message)
    })
    it("reports line and column", () => {
        expect(() => XmlReader.parse("<a>\n  <b>\n</a>")).toThrow("(line 3, column")
    })
})

describe("XmlReader whitespace", () => {
    it("drops whitespace between child elements but keeps text of leaf elements", () => {
        const node = XmlReader.parse("<a>\n  <b>  </b>\n  <c/>\n</a>")
        expect(node.text).toBe("")
        expect(node.children[0].text).toBe("  ")
    })
})
