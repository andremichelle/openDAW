import {describe, expect, it} from "vitest"
import {readdirSync, readFileSync} from "node:fs"
import {resolve} from "node:path"
import {ScriptEntryPoints} from "./ScriptEntryPoints"

const entry = (name: string): ScriptEntryPoints.Entry => ({name, signature: name, documentation: ""})
const parameter = (name: string, fields: ReadonlyArray<string> = [], elements: ReadonlyArray<string> = []): ScriptEntryPoints.Parameter =>
    ({...entry(name), fields: fields.map(entry), elements: elements.map(entry)})
const method = (name: string, generator: boolean = false,
                parameters: ReadonlyArray<ScriptEntryPoints.Parameter> = []): ScriptEntryPoints.Method =>
    ({name, generator, signature: `${name}()`, documentation: "", parameters})
const property = (name: string, keys: ScriptEntryPoints.Property["keys"] = null): ScriptEntryPoints.Property =>
    ({name, keys, signature: name, documentation: ""})
const api = (methods: ReadonlyArray<ScriptEntryPoints.Method>,
             properties: ReadonlyArray<ScriptEntryPoints.Property> = []): ScriptEntryPoints.Api =>
    ({className: "Processor", methods, properties, globals: [{name: "sampleRate", signature: "sampleRate", documentation: ""}]})

const BLOCK = parameter("block", ["s0", "s1", "bpm"])
const AUDIO_EFFECT = api([method("process", false, [parameter("io", ["src", "out"]), BLOCK]),
        method("paramChanged", false, [parameter("label"), parameter("value")]), method("reset")],
    [property("samples", "sample"), property("sidechains", "sidechain"), property("latency")])
const INSTRUMENT = api([method("process", false, [parameter("output", [], ["left", "right"]), BLOCK]),
        method("paramChanged"), method("reset"), method("noteOn"), method("noteOff")],
    [property("samples", "sample"), property("sidechains", "sidechain")])
const MIDI_EFFECT = api([method("process", true), method("paramChanged"), method("reset")])

const names = (code: string, className: string = "Processor") =>
    ScriptEntryPoints.scanClass(code, className).map(member => member.name)

const findings = (code: string, scriptApi: ScriptEntryPoints.Api) =>
    ScriptEntryPoints.analyse(code, scriptApi).filter(finding => finding.type !== "argument")
        .map(finding => `${finding.type}:${finding.name}->${finding.entry.name}`)

describe("ScriptEntryPoints.scanClass", () => {
    it("finds methods of the named class only", () => {
        const code = `
class Voice { process() {} }
class Processor {
    process(io, block) {}
    reset() {}
}`
        expect(names(code)).toEqual(["process", "reset"])
        expect(names(code, "Voice")).toEqual(["process"])
    })
    it("returns nothing without the class", () => {
        expect(names("class Other { process() {} }")).toEqual([])
        expect(names("")).toEqual([])
    })
    it("reports the offset of the method name", () => {
        const code = "class Processor {\n    paramChanged(name, value) {}\n}"
        const [member] = ScriptEntryPoints.scanClass(code, "Processor")
        expect(code.slice(member.offset, member.offset + member.name.length)).toBe("paramChanged")
    })
    it("detects generators, statics and modifiers", () => {
        const members = ScriptEntryPoints.scanClass(`
class Processor {
    * process(block, events) {}
    static create() {}
    async load() {}
    get value() { return 1 }
    *next() {}
}`, "Processor")
        expect(members.map(({name, generator, isStatic}) => [name, generator, isStatic])).toEqual([
            ["process", true, false], ["create", false, true], ["load", false, false],
            ["value", false, false], ["next", true, false]
        ])
    })
    it("ignores calls inside field initializers and method bodies", () => {
        const code = `
class Processor {
    voices = []
    table = createTable(2048)
    gain = Math.max(0,
        clamp(1))
    process(io, block) {
        this.reset()
        helper(1)
    }
}`
        expect(names(code)).toEqual(["process"])
    })
    it("ignores methods of nested object literals and classes", () => {
        const code = `
class Processor {
    lookup = { reset() {} }
    process() {
        const inner = class { noteOn() {} }
    }
}`
        expect(names(code)).toEqual(["process"])
    })
    it("survives strings, comments, templates and regex containing braces", () => {
        const code = `
class Processor {
    label = "}"
    other = '{'
    // }
    /* } */
    pattern = /[}{]+/g
    text = \`a \${ {b: 1}.b } } \${\`nested \${1}\`} c\`
    process() {
        const half = 4 / 2 / 1
        return \`}\`
    }
    reset() {}
}`
        expect(names(code)).toEqual(["process", "reset"])
    })
    it("finds members after fields without semicolons", () => {
        const code = `
class Processor {
    dirty = true
    paramChanged(name, value) {}
    label = \`x\`
    reset() {}
    table = [1, 2]
    process() {}
}`
        expect(names(code)).toEqual(["paramChanged", "reset", "process"])
    })
    it("does not treat continued expressions as members", () => {
        const code = `
class Processor {
    gain = 1 +
        helper(2) {}
    other = scale
        .map(value => value)
    process() {}
}`
        expect(names(code)).toEqual(["process"])
    })
    it("handles extends and computed members", () => {
        expect(names("class Processor extends Base { [Symbol.iterator]() {} process() {} }")).toEqual(["process"])
    })
    it("keeps private methods visible to the scanner", () => {
        expect(names("class Processor { #order() {} process() {} }")).toEqual(["#order", "process"])
    })
})

describe("ScriptEntryPoints.analyse", () => {
    it("marks known methods", () => {
        expect(findings("class Processor { process() {} paramChanged() {} reset() {} }", AUDIO_EFFECT))
            .toEqual(["known:process->process", "known:paramChanged->paramChanged", "known:reset->reset"])
    })
    it("warns about case mistakes and one-letter typos", () => {
        expect(findings("class Processor { paramchanged() {} noteon() {} noteOf() {} proces() {} }", INSTRUMENT))
            .toEqual(["near-miss:paramchanged->paramChanged", "near-miss:noteon->noteOn",
                "near-miss:noteOf->noteOff", "near-miss:proces->process"])
    })
    it("does not flag helpers that are merely similar", () => {
        expect(findings("class Processor { processVoice() {} resetVoices() {} rest() {} param() {} }", AUDIO_EFFECT))
            .toEqual([])
    })
    it("leaves short names alone except for case mistakes", () => {
        expect(ScriptEntryPoints.findNearMiss("rest", AUDIO_EFFECT.methods)).toBeNull()
        expect(ScriptEntryPoints.findNearMiss("Reset", AUDIO_EFFECT.methods)?.name).toBe("reset")
    })
    it("warns when the generator form does not match", () => {
        expect(findings("class Processor { process(block, events) {} }", MIDI_EFFECT))
            .toEqual(["generator-mismatch:process->process"])
        expect(findings("class Processor { * process(io, block) {} }", AUDIO_EFFECT))
            .toEqual(["generator-mismatch:process->process"])
    })
    it("warns about static entry points", () => {
        expect(findings("class Processor { static reset() {} }", AUDIO_EFFECT)).toEqual(["static:reset->reset"])
    })
    it("marks injected properties and checks their keys against the declarations", () => {
        const code = `// @sample grain
// @sidechain Key
class Processor {
    process() {
        const data = this.samples.grain
        const missing = this.samples.grian
        const [left] = this.sidechains.Key
        const [other] = this.sidechains.Gate
        this.latency = 64
        const all = this.samples
        this.gain = 1
    }
}`
        expect(findings(code, AUDIO_EFFECT)).toEqual([
            "known:process->process",
            "known:samples->samples", "known:samples->samples", "undeclared:grian->samples",
            "known:sidechains->sidechains", "known:sidechains->sidechains", "undeclared:Gate->sidechains",
            "known:latency->latency", "known:samples->samples"
        ])
    })
    it("names the declared keys in the warning", () => {
        const undeclared = ScriptEntryPoints.analyse("class Processor { process() { this.samples.foo } }", AUDIO_EFFECT)
            .find(finding => finding.type === "undeclared")
        expect(undeclared?.warning).toBe("No '// @sample foo' declared (declared: none)")
    })
    it("ignores properties the device kind does not inject", () => {
        expect(findings("class Processor { * process() { this.samples.grain } }", MIDI_EFFECT))
            .toEqual(["known:process->process"])
    })
    it("ignores this-access outside the Processor class", () => {
        expect(findings("class Voice { run() { this.samples.foo } }\nclass Processor { process() {} }", AUDIO_EFFECT))
            .toEqual(["known:process->process"])
    })
    it("marks globals but not same-named members", () => {
        expect(findings("const RATE = sampleRate\nclass Processor { process() { this.sampleRate = sampleRate } }", AUDIO_EFFECT))
            .toEqual(["known:sampleRate->sampleRate", "known:process->process", "known:sampleRate->sampleRate"])
    })
    it("ignores private methods", () => {
        expect(findings("class Processor { #process() {} #reset() {} }", AUDIO_EFFECT)).toEqual([])
    })
})

describe("ScriptEntryPoints arguments", () => {
    const argumentsOf = (code: string, scriptApi: ScriptEntryPoints.Api) =>
        ScriptEntryPoints.analyse(code, scriptApi).filter(finding => finding.type === "argument")
            .map(finding => `${finding.name}->${finding.entry.name}`)
    it("documents named parameters and their fields in the body", () => {
        expect(argumentsOf(`class Processor {
    process(io, block) {
        const left = io.src[0]
        for (let index = block.s0; index < block.s1; index++) {}
        const other = io.unknown
    }
}`, AUDIO_EFFECT)).toEqual([
            "io->io", "block->block", "io->io", "src->src", "block->block", "s0->s0", "block->block", "s1->s1", "io->io"
        ])
    })
    it("documents destructured fields, aliases and their local uses", () => {
        expect(argumentsOf(`class Processor {
    process({src, out}, {s0: start, s1}) {
        for (let index = start; index < s1; index++) {out[0][index] = src[0][index]}
    }
}`, AUDIO_EFFECT)).toEqual([
            "src->src", "out->out", "s0->s0", "start->s0", "s1->s1", "start->s0", "s1->s1", "out->out", "src->src"
        ])
    })
    it("documents array parameters by element index", () => {
        expect(argumentsOf(`class Processor {
    process(output, block) { const left = output[0], right = output[1], third = output[2] }
    noteOn(pitch) {}
}`, INSTRUMENT)).toEqual([
            "output->output", "block->block", "output->output", "0->left", "output->output", "1->right", "output->output"
        ])
        expect(argumentsOf("class Processor { process([outL, outR, extra], block) { outL[0] = outR[0] } }", INSTRUMENT))
            .toEqual(["outL->left", "outR->right", "block->block", "outL->left", "outR->right"])
    })
    it("ignores member accesses of the same name and other methods' scopes", () => {
        expect(argumentsOf(`class Processor {
    paramChanged(label, value) { this.value = value }
    helper(label) { return label }
}`, AUDIO_EFFECT)).toEqual(["label->label", "value->value", "value->value"])
    })
    it("survives defaults and rest parameters", () => {
        expect(argumentsOf("class Processor { paramChanged(label = \"x\", ...rest) { return label } }", AUDIO_EFFECT))
            .toEqual(["label->label", "label->label"])
    })
})

describe("ScriptEntryPoints over the shipped examples", () => {
    const root = resolve(__dirname, "../../../app/studio/src/ui/devices")
    const kinds: ReadonlyArray<[string, ScriptEntryPoints.Api]> = [
        ["audio-effects", AUDIO_EFFECT], ["instruments", INSTRUMENT], ["midi-effects", MIDI_EFFECT]
    ]
    for (const [folder, scriptApi] of kinds) {
        const directory = resolve(root, folder, "examples")
        const files = readdirSync(directory).filter(name => name.endsWith(".js"))
        for (const file of files) {
            it(`${folder}/${file} finds every declared entry point and no warnings`, () => {
                const code = readFileSync(resolve(directory, file), "utf8")
                const result = ScriptEntryPoints.analyse(code, scriptApi)
                expect(result.filter(finding => finding.warning !== null)).toEqual([])
                const declared = scriptApi.methods.map(({name}) => name)
                    .filter(name => new RegExp(`^\\s+(\\*\\s*)?${name}\\s*\\(`, "m").test(code.slice(code.indexOf("class Processor"))))
                const methodNames = result.filter(finding => scriptApi.methods.some(entry => entry === finding.entry))
                    .map(finding => finding.entry.name)
                expect(methodNames.sort()).toEqual(declared.sort())
            })
        }
    }
})
