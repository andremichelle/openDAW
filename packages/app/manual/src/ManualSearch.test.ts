import {describe, expect, it} from "vitest"
import {ManualSearch} from "./ManualSearch"
import {ManualPageEntry} from "./Manuals"

const page = (label: string, path: string): ManualPageEntry => ({type: "page", label, path})

describe("ManualSearch.normalize", () => {
    it("drops markdown syntax, image and link urls", () => {
        expect(ManualSearch.normalize("# Title\n![shot](image.webp) see [the **mixer**](/manuals/mixer)"))
            .toBe("title see the mixer")
    })
    it("drops inline html tags but keeps their text", () => {
        expect(ManualSearch.normalize("<kbd>Shift</kbd>+<b>Click</b>")).toBe("shift click")
    })
    it("keeps non-latin letters and digits", () => {
        expect(ManualSearch.normalize("Größe: 24-bit")).toBe("größe 24 bit")
    })
    it("turns an empty or symbol-only text into an empty string", () => {
        expect(ManualSearch.normalize("")).toBe("")
        expect(ManualSearch.normalize(" --- | * ")).toBe("")
    })
})

describe("ManualSearch.pathOf", () => {
    it("maps index to the manuals root and others below it", () => {
        expect(ManualSearch.pathOf("index")).toBe("/manuals/")
        expect(ManualSearch.pathOf("mixer")).toBe("/manuals/mixer")
        expect(ManualSearch.pathOf("devices/audio/delay")).toBe("/manuals/devices/audio/delay")
    })
})

describe("ManualSearch.find", () => {
    const mixer = page("Mixer", "/manuals/mixer")
    const delay = page("Delay", "/manuals/devices/audio/delay")
    const filter = page("Note Filter", "/manuals/devices/midi/note-filter")
    const pages = [mixer, delay, filter]
    const texts: ManualSearch.Texts = {
        "/manuals/mixer": "the mixer has faders and a delay send",
        "/manuals/devices/audio/delay": "a stereo delay with feedback",
        "/manuals/devices/midi/note-filter": "lets notes pass by key range"
    }
    it("returns nothing for an empty or blank query", () => {
        expect(ManualSearch.find(pages, texts, "")).toEqual([])
        expect(ManualSearch.find(pages, texts, "   ")).toEqual([])
        expect(ManualSearch.find(pages, texts, "*-*")).toEqual([])
    })
    it("lists title matches before content matches", () => {
        expect(ManualSearch.find(pages, texts, "delay")).toEqual([delay, mixer])
    })
    it("requires every word, in any order and partially typed", () => {
        expect(ManualSearch.find(pages, texts, "filt note")).toEqual([filter])
        expect(ManualSearch.find(pages, texts, "stereo feed")).toEqual([delay])
        expect(ManualSearch.find(pages, texts, "stereo faders")).toEqual([])
    })
    it("ignores case and punctuation in the query", () => {
        expect(ManualSearch.find(pages, texts, "KEY-Range!")).toEqual([filter])
    })
    it("matches the title even without a text", () => {
        expect(ManualSearch.find(pages, {}, "mix")).toEqual([mixer])
        expect(ManualSearch.find(pages, {}, "faders")).toEqual([])
    })
    it("lists a page that appears twice in the nav once", () => {
        const twice = page("WebCLAP", "/manuals/devices/audio/wclap")
        expect(ManualSearch.find([twice, mixer, twice], {}, "webclap")).toEqual([twice])
    })
    it("does not match words across the title and the text", () => {
        expect(ManualSearch.find(pages, texts, "mixer feedback")).toEqual([])
    })
})
