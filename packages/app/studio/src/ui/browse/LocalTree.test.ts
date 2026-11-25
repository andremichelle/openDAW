import {describe, expect, it, vi} from "vitest"
import {LocalTree} from "./LocalTree"

// studio-core needs browser audio classes at load time, importPath uses none of it
vi.mock("@opendaw/studio-core", () => ({}))

describe("LocalTree.importPath", () => {
    it("renames a folder imported into the root under the name of the trash", () => {
        expect(LocalTree.importPath("", "Trash")).toBe("Trash 2")
        expect(LocalTree.importPath("", "trash/Kicks")).toBe("trash 2/Kicks")
    })
    it("keeps every other path", () => {
        expect(LocalTree.importPath("", "Kits/Trash")).toBe("Kits/Trash")
        expect(LocalTree.importPath("Kits", "Trash")).toBe("Kits/Trash")
        expect(LocalTree.importPath("", "Trashy")).toBe("Trashy")
    })
})
