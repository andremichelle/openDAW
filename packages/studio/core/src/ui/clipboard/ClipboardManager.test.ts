import {afterEach, describe, expect, it, vi} from "vitest"
import {Option, RuntimeNotifier, Terminable} from "@opendaw/lib-std"
import {ClipboardManager, type ClipboardEntry, type ClipboardHandler} from "./ClipboardManager"

const io = vi.hoisted(() => ({writeText: vi.fn(), readText: vi.fn()}))
vi.mock("@opendaw/lib-dom", async importOriginal => ({...await importOriginal<object>(), Clipboard: io}))
vi.mock("./ContextMenu", () => ({ContextMenu: {subscribe: () => ({terminate() {}})}}))
const owned: Terminable[] = []
afterEach(() => {owned.splice(0).forEach(x => x.terminate()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks()})
const entry = (type: string): ClipboardEntry => ({type, data: new Uint8Array([1, 2]).buffer})
const handler = (type: string): ClipboardHandler<ClipboardEntry> => ({
    canCopy: () => true, canCut: () => true, canPaste: value => value.type === type,
    copy: vi.fn(() => Option.wrap(entry(type))), cut: vi.fn(() => Option.wrap(entry(type))), paste: vi.fn()
})
function setup() {
    vi.spyOn(RuntimeNotifier, "notify").mockImplementation(() => {})
    const parent = document.createElement("div"), child = document.createElement("div"), header = document.createElement("div")
    child.tabIndex = header.tabIndex = -1
    parent.append(header, child); document.body.append(parent)
    const tracks = handler("audio-units"), regions = handler("regions")
    // Actual timeline registration order: parent track handler is installed before its child editor.
    owned.push(ClipboardManager.install(parent, tracks), ClipboardManager.install(child, regions))
    return {parent, child, header, tracks, regions}
}
const key = (element: HTMLElement, key: string, mac = false) => element.dispatchEvent(new KeyboardEvent("keydown", {
    key, ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true
}))
function paste(element: HTMLElement, type: string) {
    const event = new Event("paste", {bubbles: true, cancelable: true})
    Object.defineProperty(event, "clipboardData", {value: {getData: () => ClipboardManager.encode(entry(type))}})
    element.dispatchEvent(event)
}

describe("nested clipboard focus", () => {
    it.each([false, true])("copies the focused region rather than its whole track (Mac=%s)", mac => {
        const {child, tracks, regions} = setup(); child.focus(); key(child, "c", mac)
        expect(regions.copy).toHaveBeenCalledTimes(1); expect(tracks.copy).not.toHaveBeenCalled()
        expect(ClipboardManager.decode(io.writeText.mock.calls[0][0]).unwrap().type).toBe("regions")
    })
    it("cuts regions and routes a region paste to their editor", () => {
        const {child, tracks, regions} = setup(); child.focus(); key(child, "x"); paste(child, "regions")
        expect(regions.cut).toHaveBeenCalledTimes(1); expect(tracks.cut).not.toHaveBeenCalled()
        expect(regions.paste).toHaveBeenCalledTimes(1); expect(tracks.paste).not.toHaveBeenCalled()
    })
    it("keeps track copying from headers and accepts track pastes through an ancestor", () => {
        const {header, child, tracks, regions} = setup(); header.focus(); key(header, "c")
        expect(tracks.copy).toHaveBeenCalledTimes(1); expect(regions.copy).not.toHaveBeenCalled()
        child.focus(); paste(child, "audio-units"); expect(tracks.paste).toHaveBeenCalledTimes(1)
    })
    it("does not copy the track when its focused region editor has no selection", () => {
        const {child, tracks, regions} = setup(); regions.canCopy = () => false; child.focus(); key(child, "c")
        child.dispatchEvent(new Event("copy", {bubbles: true, cancelable: true}))
        expect(regions.copy).not.toHaveBeenCalled(); expect(tracks.copy).not.toHaveBeenCalled()
    })
    it("preserves native text copying inside editors", () => {
        const {child, tracks, regions} = setup(); const input = document.createElement("input"); child.append(input); input.focus(); key(input, "c")
        expect(regions.copy).not.toHaveBeenCalled(); expect(tracks.copy).not.toHaveBeenCalled()
    })
})
