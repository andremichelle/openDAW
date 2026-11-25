import {describe, expect, it} from "vitest"
import {ScriptPreamble} from "../ScriptPreamble"

describe("ScriptPreamble.strip", () => {
    it("drops an import preamble up to the first comment", () => {
        const source = "import {Api} from \"@opendaw/studio-scripting\"\n\nconst openDAW: Api = undefined as never\n\n// start\nrun()\n"
        expect(ScriptPreamble.strip(source)).toBe("// start\nrun()\n")
    })
    it("keeps a script without imports untouched", () => {
        expect(ScriptPreamble.strip("// hello\nrun()\n")).toBe("// hello\nrun()\n")
        expect(ScriptPreamble.strip("run() // trailing\n")).toBe("run() // trailing\n")
        expect(ScriptPreamble.strip("")).toBe("")
    })
    it("accepts leading whitespace before the imports", () => {
        expect(ScriptPreamble.strip("\n  import x from \"y\"\n// go\n")).toBe("// go\n")
    })
    it("returns nothing for a preamble without a comment", () => {
        expect(ScriptPreamble.strip("import x from \"y\"\nrun()\n")).toBe("")
    })
    it("does not mistake an identifier starting with import for an import", () => {
        expect(ScriptPreamble.strip("importantValue()\n// x\n")).toBe("importantValue()\n// x\n")
    })
})
