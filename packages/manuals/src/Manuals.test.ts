import {existsSync} from "node:fs"
import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {describe, expect, it} from "vitest"
import {collectManualPages, isManualsIndex, manualsMarkdownHref, Manuals} from "./Manuals"

const contentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../content")

describe("Manuals nav", () => {
    it("points every page at a markdown file", () => {
        const missing = collectManualPages(Manuals)
            .map(page => page.path.replace(/^\/manuals\//, "") + ".md")
            .filter(relative => !existsSync(resolve(contentDir, relative)))
        expect(missing).toEqual([])
    })
    it("resolves the manuals index to index.md", () => {
        expect(isManualsIndex("/manuals")).toBe(true)
        expect(isManualsIndex("/manuals/")).toBe(true)
        expect(isManualsIndex("/manuals/introduction")).toBe(false)
        expect(manualsMarkdownHref("/manuals/")).toBe("/manuals/index.md")
        expect(manualsMarkdownHref("/manuals/introduction")).toBe("/manuals/introduction.md")
    })
    it("ships the index markdown used at /manuals/", () => {
        expect(existsSync(resolve(contentDir, "index.md"))).toBe(true)
    })
})
