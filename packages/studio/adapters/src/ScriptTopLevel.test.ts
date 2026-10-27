import {describe, expect, it} from "vitest"
import {readdirSync, readFileSync} from "node:fs"
import {resolve} from "node:path"
import {ScriptTopLevel} from "./ScriptTopLevel"

const violations = (code: string) => ScriptTopLevel.check(code).violations.map(({line, message}) => `${line}: ${message}`)
const declarations = (code: string) => ScriptTopLevel.check(code).declarations
    .map(({kind, name, viaCall}) => `${kind}:${name}${viaCall ? ":call" : ""}`)

// Evaluates the code the way the wrapper does: strict, then the freeze calls, then returns `probe()`.
const evaluate = (code: string, probe: string = "undefined") => {
    const {declarations: found} = ScriptTopLevel.check(code)
    return new Function(`"use strict"\n${code}\n${ScriptTopLevel.freezeSource(found)}\nreturn (() => ${probe})()`)()
}

describe("ScriptTopLevel.applies", () => {
    it("applies only to scripts with a view or a window", () => {
        expect(ScriptTopLevel.applies("// @view 1 1 4 3\nclass View {}")).toBe(true)
        expect(ScriptTopLevel.applies("// @window 800 600\nclass View {}")).toBe(true)
        expect(ScriptTopLevel.applies("// @param gain 1\nclass Processor {}")).toBe(false)
        expect(ScriptTopLevel.applies("class View {}")).toBe(false)
        expect(ScriptTopLevel.applies("// @viewport 1")).toBe(false)
    })
})

describe("ScriptTopLevel.check rejects", () => {
    it("let and var", () => {
        expect(violations("let current = 0\nclass View {}")).toEqual([
            "1: Top-level 'let current' would exist separately in the processor and the view. Move it into the class."
        ])
        expect(violations("class Processor {}\nvar x")).toHaveLength(1)
    })
    it("expression statements", () => {
        expect(violations("init()\nclass Processor {}")).toEqual([
            "1: Top-level statement 'init()' is not allowed, only class, function and const."
        ])
        expect(violations("const S = [1]\nS.push(2)")).toHaveLength(1)
        expect(violations("if (true) {}\nclass P {}")).toHaveLength(1)
        expect(violations("class P {}\n(() => { globalThis.x = 1 })()")).toHaveLength(1)
    })
    it("destructuring const", () => {
        expect(violations("const {a, b} = {a: 1, b: 2}")).toEqual([
            "1: Top-level 'const' must be 'const NAME = ...', no destructuring."
        ])
        expect(violations("const [a] = [1]")).toHaveLength(1)
    })
    it("import and export", () => {
        expect(violations("export class Processor {}")).toEqual(["1: 'export' is not supported in scripts."])
        expect(violations("import x from \"y\"")).toHaveLength(1)
    })
    it("a let after a semicolon on the same line", () => {
        expect(violations("const A = 1; let b = 2")).toHaveLength(1)
    })
    it("a statement directly after a class on the same line", () => {
        expect(violations("class A {} let x = 1")).toHaveLength(1)
    })
    it("private static fields but not private static methods", () => {
        expect(violations("class Counter { static #count = 0 }")).toEqual([
            "1: 'static #count' is shared state freezing cannot reach. Make it an instance field."
        ])
        expect(violations("class Counter { static #next() {} static #ready }")).toHaveLength(1)
    })
    it("with the right line numbers", () => {
        expect(violations("// @view 1 1 2 3\n\nclass View {}\n\nlet late = 1")[0]).toMatch(/^5: /)
    })
})

describe("ScriptTopLevel.check accepts", () => {
    const accepted = {
        "multi-line const": "const A = 1 +\n    2\nconst B = [\n  1,\n  2\n]\nclass P {}",
        "leading dot continuation": "const A = [1, 2]\n    .map(value => value * 2)\nclass P {}",
        "ternary continuation": "const A = true\n    ? 1\n    : 2",
        "regex with brace": "const R = /[{]+/g\nclass P { m() { return \"}\" } }",
        "nested template literal": "const T = `a ${`b ${1 + 1}`} c`\nclass P {}",
        "comments containing let": "// let x = 1\n/* var y */\nclass P {}",
        "let inside class": "class P { process() { let x = 0; for (let i = 0; i < 3; i++) x++ } }",
        "multi-line arrow const": "const f = (value) =>\n    value * 2\nclass P {}",
        "division": "const A = 4 / 2 / 1\nclass P {}",
        "async and generator functions": "async function load() {}\nfunction* gen() {}\nclass P {}",
        "class expression const": "const Helper = class { static n = 0 }",
        "object const with methods": "const API = {\n  run() { return 1 },\n  value: 2\n}",
        "empty statements": ";\nclass P {};\n",
        "class with extends call": "class P extends mixin({a: 1}) {\n    process() {}\n}\nconst A = 1",
        "function with destructured defaults": "function make({a = {b: 1}} = {}) {\n    return a\n}\nclass P {}",
        "several consts in one statement": "const A = 1, B = 2\nclass P {}",
        "public static fields": "class P { static SCALES = [1, 2] }"
    }
    for (const [name, code] of Object.entries(accepted)) {
        it(name, () => expect(violations(code)).toEqual([]))
    }
    it("every shipped example", () => {
        const root = resolve(__dirname, "../../../app/studio/src/ui/devices")
        for (const folder of ["audio-effects", "instruments", "midi-effects"]) {
            const directory = resolve(root, folder, "examples")
            for (const file of readdirSync(directory).filter(name => name.endsWith(".js"))) {
                expect(violations(readFileSync(resolve(directory, file), "utf8")), file).toEqual([])
            }
        }
    })
})

describe("ScriptTopLevel declarations", () => {
    it("lists classes, functions and consts", () => {
        expect(declarations("const A = 1, B = 2\nfunction helper() {}\nasync function load() {}\nfunction* gen() {}\nclass Processor {}"))
            .toEqual(["const:A", "const:B", "function:helper", "function:load", "function:gen", "class:Processor"])
    })
    it("marks consts whose initializer calls something", () => {
        expect(declarations([
            "const ROOT = Math.pow(2, 1 / 12)",
            "const TABLE = Array.from({length: 4}, (entry, index) => index)",
            "const next = (() => { let count = 0; return () => ++count })()",
            "const MAP = new Map()",
            "const plain = (value) => value * 2",
            "const API = { run() { return 1 } }",
            "const NUMBERS = [1, 2]",
            "const wrapped = value => helper(value)",
            "const braced = (value) => { return helper(value) }",
            "const method = {run() { return helper(1) }, other: compute(2)}",
            "const pair = [value => helper(value), compute(3)]"
        ].join("\n"))).toEqual([
            "const:ROOT:call", "const:TABLE:call", "const:next:call", "const:MAP:call",
            "const:plain", "const:API", "const:NUMBERS", "const:wrapped", "const:braced", "const:method:call", "const:pair:call"
        ])
    })
})

describe("ScriptTopLevel.freezeSource at runtime", () => {
    it("freezes const arrays and objects deeply", () => {
        expect(() => evaluate("const SCALES = [[0, 2], [0, 3]]", "SCALES.push([1])")).toThrow(TypeError)
        expect(() => evaluate("const SCALES = [[0, 2], [0, 3]]", "SCALES[0][0] = 9")).toThrow(TypeError)
        expect(() => evaluate("const API = {nested: {value: 1}}", "API.nested.value = 2")).toThrow(TypeError)
    })
    it("freezes class statics and function properties", () => {
        expect(() => evaluate("class Helper { static counter = 0 }", "Helper.counter++")).toThrow(TypeError)
        expect(() => evaluate("class Helper { static SCALES = [1] }", "Helper.SCALES.push(2)")).toThrow(TypeError)
        expect(() => evaluate("function util() {}", "util.cache = 1")).toThrow(TypeError)
    })
    it("keeps prototypes open (no override mistake) and instances writable", () => {
        expect(evaluate("class View { constructor() { this.draw = this.draw.bind(this); this.current = 3 } draw() { return 1 } }",
            "new View().draw() + new View().current")).toBe(4)
    })
    it("rejects typed arrays, maps and sets", () => {
        expect(() => evaluate("const TABLE = new Float32Array(4)")).toThrow("'TABLE' holds a typed array")
        expect(() => evaluate("const CACHE = new Map()")).toThrow("'CACHE' holds a Map")
        expect(() => evaluate("const SEEN = new Set()")).toThrow("'SEEN' holds a Set")
        expect(() => evaluate("const LOOKUP = {cache: new Map()}")).toThrow("'LOOKUP' holds a Map")
        expect(evaluate("const EMPTY = new Float32Array(0)", "EMPTY.length")).toBe(0)
    })
    it("rejects closures created by a call", () => {
        expect(() => evaluate("const next = (() => { let count = 0; return () => ++count })()"))
            .toThrow("'next' is a function created by a call")
        expect(() => evaluate("function makeApi() { let n = 0; return {inc: () => ++n} }\nconst api = makeApi()"))
            .toThrow("'api' is a function created by a call")
    })
    it("accepts call results without functions and literal functions", () => {
        expect(evaluate("const TABLE = Array.from({length: 4}, (entry, index) => index * 2)", "TABLE[3]")).toBe(6)
        expect(evaluate("const ROOT = Math.pow(2, 1 / 12)", "ROOT > 1")).toBe(true)
        expect(evaluate("const double = value => value * 2\nconst API = {run() { return double(2) }}", "API.run()")).toBe(4)
    })
    it("freezes the plan examples without errors", () => {
        expect(evaluate("const TABLE_SIZE = 2048\nconst KEYS = 24\nconst BASE_PITCH = 48\nclass Processor {}\nclass View {}", "KEYS")).toBe(24)
    })
})
