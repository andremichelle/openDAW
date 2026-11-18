// @vitest-environment node
import {describe, expect, it} from "vitest"
import {Xml} from "./Xml"

enum Kind {A = "a", B = "b"}

abstract class Named {
    @Xml.Attribute("name") declare readonly name?: string
    @Xml.Attribute("id", Xml.StringRequired) declare readonly id: string
}

@Xml.Class("Leaf")
class Leaf extends Named {
    @Xml.Attribute("value", Xml.NumberOptional) declare readonly value?: number
}

@Xml.Class("Special")
class Special extends Leaf {
    @Xml.Attribute("kind", Xml.Enum(Kind, false)) declare readonly kind?: Kind
}

@Xml.Class("Other")
class Other extends Named {
    @Xml.Child(() => Leaf, {name: "Inner"}) declare readonly inner?: Leaf
}

class Param {
    @Xml.Attribute("count", Xml.IntRequired) declare readonly count: number
    @Xml.Attribute("on", Xml.BoolOptional) declare readonly on?: boolean
    @Xml.Attribute("tags", Xml.List(Xml.StringRequired, false)) declare readonly tags?: ReadonlyArray<string>
}

@Xml.Class("Root")
class Root extends Named {
    @Xml.Text("Title") declare readonly title?: string
    @Xml.Children(() => [Leaf, Special, Other], {wrapper: "Items"}) declare readonly items: ReadonlyArray<Named>
    @Xml.Child(() => Param, {name: "Param", required: true}) declare readonly param: Param
    @Xml.Children(() => Param, {name: "Extra"}) declare readonly extras: ReadonlyArray<Param>
    @Xml.Children(() => [Leaf, Special]) declare readonly direct: ReadonlyArray<Leaf>
    @Xml.Child(() => [Leaf, Other]) declare readonly single?: Named
}

@Xml.Class("Override")
class Override extends Leaf {
    @Xml.Attribute("value", Xml.IntOptional) declare readonly value?: number
}

const sample = (): Root => Xml.element({
    id: "r", name: "root", title: "A & B",
    items: [
        Xml.element({id: "1", value: 0.5}, Leaf),
        Xml.element({id: "2", kind: Kind.B}, Special),
        Xml.element({id: "3", inner: Xml.element({id: "4"}, Leaf)}, Other)
    ],
    param: Xml.element({count: 3, on: true, tags: ["x", "y"]}, Param),
    extras: [Xml.element({count: 1}, Param), Xml.element({count: 2}, Param)],
    direct: [Xml.element({id: "5"}, Special), Xml.element({id: "6"}, Leaf)],
    single: Xml.element({id: "7"}, Other)
}, Root)

describe("Xml binding", () => {
    it("writes elements in declaration order, parents first, attributes before elements", () => {
        expect(Xml.write(sample(), {declaration: false})).toBe([
            "<Root name=\"root\" id=\"r\">",
            "  <Title>A &amp; B</Title>",
            "  <Items>",
            "    <Leaf id=\"1\" value=\"0.5\"/>",
            "    <Special id=\"2\" kind=\"b\"/>",
            "    <Other id=\"3\">",
            "      <Inner id=\"4\"/>",
            "    </Other>",
            "  </Items>",
            "  <Param count=\"3\" on=\"true\" tags=\"x y\"/>",
            "  <Extra count=\"1\"/>",
            "  <Extra count=\"2\"/>",
            "  <Special id=\"5\"/>",
            "  <Leaf id=\"6\"/>",
            "  <Other id=\"7\"/>",
            "</Root>"
        ].join("\n"))
    })
    it("reads back what it wrote, with the right classes", () => {
        const {value, issues} = Xml.read(Xml.write(sample()), Root)
        expect(issues).toEqual([])
        expect(value).toBeInstanceOf(Root)
        expect(value.title).toBe("A & B")
        expect(value.items.map(item => item.constructor)).toEqual([Leaf, Special, Other])
        expect((value.items[0] as Leaf).value).toBe(0.5)
        expect((value.items[1] as Special).kind).toBe(Kind.B)
        expect((value.items[2] as Other).inner?.id).toBe("4")
        expect(value.param.count).toBe(3)
        expect(value.param.on).toBe(true)
        expect(value.param.tags).toEqual(["x", "y"])
        expect(value.extras.map(extra => extra.count)).toEqual([1, 2])
        expect(value.direct.map(item => item.constructor)).toEqual([Special, Leaf])
        expect(value.single).toBeInstanceOf(Other)
        expect(Xml.write(value)).toBe(Xml.write(sample()))
    })
    it("defaults absent lists to empty frozen arrays and absent values to undefined", () => {
        const value = Xml.parse(`<Root id="r"><Param count="1"/></Root>`, Root)
        expect(value.items).toEqual([])
        expect(Object.isFrozen(value.items)).toBe(true)
        expect(value.title).toBeUndefined()
        expect(Object.isFrozen(value)).toBe(true)
    })
    it("reads children in any order", () => {
        const value = Xml.parse(`<Root id="r"><Leaf id="a"/><Param count="1"/><Items><Leaf id="b"/></Items><Title>t</Title></Root>`, Root)
        expect(value.direct[0].id).toBe("a")
        expect(value.items[0].id).toBe("b")
        expect(value.title).toBe("t")
    })
    it("reports unknown elements, attributes and repetitions", () => {
        const {issues} = Xml.read(`<Root id="r" foo="1" xmlns:xsi="x" xsi:noNamespaceSchemaLocation="y"><Param count="1"/><Param count="2"/><Bar/><Items><Baz/></Items><Other id="x"/><Leaf id="y"/></Root>`, Root)
        expect(issues).toEqual([
            "Root: unknown attribute 'foo'",
            "Root/Param: unexpected repetition",
            "Root/Bar: unknown element",
            "Root/Items/Baz: unknown element"
        ])
    })
    it("reports missing required attributes and elements, writing them fails", () => {
        expect(Xml.read(`<Root><Param count="1"/></Root>`, Root).issues).toEqual(["Root: missing attribute 'id'"])
        expect(Xml.read(`<Root id="r"/>`, Root).issues).toEqual(["Root: missing element 'param'"])
        // @ts-expect-error the required param is missing on purpose
        expect(() => Xml.write(Xml.element({id: "r"}, Root))).toThrow("Root: missing required 'param'")
    })
    it("reports malformed values with their location and leaves them out, writing them fails", () => {
        const {value, issues} = Xml.read(`<Root id="r"><Param count="1.5" on="yes"/><Special id="s" kind="c"/></Root>`, Root)
        expect(issues).toEqual([
            "Root/Param@count: '1.5' is not an int",
            "Root/Param@on: 'yes' is not a boolean",
            "Root/Special@kind: 'c' is not one of a, b"
        ])
        expect(value.param.count).toBeUndefined()
        expect((value.direct[0] as Special).kind).toBeUndefined()
        expect(() => Xml.write(Xml.element({id: "r", param: Xml.element({count: 0.5}, Param)}, Root))).toThrow("Root/Param@count")
    })
    it("fails on a wrong root element", () => {
        expect(() => Xml.parse(`<Leaf id="1"/>`, Root)).toThrow("Expected root element <Root> but found <Leaf>")
    })
    it("rejects classes outside of the declared choice on write", () => {
        const root = Xml.element({id: "r", param: Xml.element({count: 1}, Param), direct: [Xml.element({id: "x"}, Other)]}, Root)
        expect(() => Xml.write(root)).toThrow("Other is not allowed here")
    })
    it("lets a subclass override an inherited attribute in place", () => {
        expect(Xml.write(Xml.element({id: "1", value: 2}, Override), {declaration: false})).toBe("<Override id=\"1\" value=\"2\"/>")
        expect(Xml.read(`<Override id="1" value="2.5"/>`, Override).issues).toEqual(["Override@value: '2.5' is not an int"])
    })
})

describe("Xml codecs", () => {
    it("booleans accept true, false, 1 and 0", () => {
        expect(["true", "false", "1", "0", " true "].map(value => Xml.BoolRequired.parse(value))).toEqual([true, false, true, false, true])
        expect(Xml.BoolRequired.parse("TRUE")).toBe(true)
        expect(() => Xml.BoolRequired.parse("yes")).toThrow()
    })
    it("doubles follow xs:double", () => {
        expect(["1", "-1.5", ".5", "1e3", "1E-3", "INF", "-INF"].map(value => Xml.NumberRequired.parse(value)))
            .toEqual([1, -1.5, 0.5, 1000, 0.001, Infinity, -Infinity])
        expect(Number.isNaN(Xml.NumberRequired.parse("NaN"))).toBe(true)
        expect(() => Xml.NumberRequired.parse("")).toThrow()
        expect(() => Xml.NumberRequired.parse("1,5")).toThrow()
        expect(() => Xml.NumberRequired.parse("0x10")).toThrow()
        expect([0.1, 1e-7, 1e21, Infinity, -Infinity, NaN].map(Xml.formatDouble)).toEqual(["0.1", "1e-7", "1e+21", "INF", "-INF", "NaN"])
    })
    it("doubles survive a round trip exactly", () => {
        const values = [Math.PI, 1 / 3, 0.1 + 0.2, 5e-324, Number.MAX_VALUE, -0.000123456789]
        values.forEach(value => expect(Xml.NumberRequired.parse(Xml.formatDouble(value))).toBe(value))
    })
    it("ints are 32 bit", () => {
        expect(Xml.IntRequired.parse("2147483647")).toBe(2147483647)
        expect(() => Xml.IntRequired.parse("2147483648")).toThrow()
        expect(Xml.IntRequired.parse("44100.0")).toBe(44100)
        expect(() => Xml.IntRequired.parse("1.5")).toThrow()
        expect(() => Xml.formatInt32(1.5)).toThrow()
    })
})
