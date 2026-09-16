import {existsSync} from "node:fs"
import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {describe, expect, it} from "vitest"
import {collectManualPages, isManualsIndex, manualsMarkdownHref, Manuals} from "./Manuals"

const contentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public")

describe("Manuals nav", () => {
    it("points every page at a markdown file", () => {
        const missing = collectManualPages(Manuals)
            .map(page => manualsMarkdownHref(page.path).replace(/^\/manuals\//, ""))
            .filter(relative => !existsSync(resolve(contentDir, relative)))
        expect(missing).toEqual([])
    })
    it("resolves the manuals index to index.md", () => {
        expect(isManualsIndex("/manuals")).toBe(true)
        expect(isManualsIndex("/manuals/")).toBe(true)
        expect(isManualsIndex("/manuals/mixer")).toBe(false)
        expect(manualsMarkdownHref("/manuals/")).toBe("/manuals/index.md")
        expect(manualsMarkdownHref("/manuals/mixer")).toBe("/manuals/mixer.md")
    })
    it("ships the index markdown used at /manuals/", () => {
        expect(existsSync(resolve(contentDir, "index.md"))).toBe(true)
    })
})
