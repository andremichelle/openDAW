import {describe, expect, test} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleDocument, SampleSource} from "./SampleDocument"
import {SampleEdits} from "./SampleEdits"

const create = (channels: ReadonlyArray<ReadonlyArray<number>>, sampleRate: number = 48000): AudioData => {
    const audio = AudioData.create(sampleRate, channels[0].length, channels.length)
    channels.forEach((channel, index) => audio.frames[index].set(channel))
    return audio
}

const source: SampleSource = {
    uuid: UUID.generate(),
    meta: {name: "Test", bpm: 0, duration: 1, sample_rate: 48000, origin: "import"}
}

const documentOf = (channels: ReadonlyArray<ReadonlyArray<number>>): SampleDocument =>
    new SampleDocument(create(channels), "Test", Option.wrap(source))

const values = (document: SampleDocument, channel: number = 0): Array<number> => Array.from(document.audio.frames[channel])

describe("SampleDocument", () => {
    test("select orders and clamps", () => {
        const document = documentOf([[1, 2, 3, 4]])
        document.select(3, 1)
        expect(document.selection.getValue()).toEqual({from: 1, to: 3})
        document.select(-5, 99)
        expect(document.selection.getValue()).toEqual({from: 0, to: 4})
    })
    test("an empty selection is a cursor", () => {
        const document = documentOf([[1, 2, 3]])
        document.select(2, 2)
        expect(document.hasSelection).toBe(false)
    })
    test("a loaded sample has no unsaved changes, a new one has", () => {
        expect(documentOf([[1]]).hasUnsavedChanges).toBe(false)
        expect(new SampleDocument(create([[1]]), "New", Option.None).hasUnsavedChanges).toBe(true)
    })
    test("undo and redo restore audio and selection", () => {
        const document = documentOf([[1, 2, 3, 4, 5]])
        document.select(1, 3)
        SampleEdits.remove(document)
        expect(values(document)).toEqual([1, 4, 5])
        expect(document.selection.getValue()).toEqual({from: 1, to: 1})
        expect(document.hasUnsavedChanges).toBe(true)
        document.undo()
        expect(values(document)).toEqual([1, 2, 3, 4, 5])
        expect(document.selection.getValue()).toEqual({from: 1, to: 3})
        expect(document.hasUnsavedChanges).toBe(false)
        document.redo()
        expect(values(document)).toEqual([1, 4, 5])
        expect(document.canRedo).toBe(false)
    })
    test("a new edit clears redo", () => {
        const document = documentOf([[1, 2, 3, 4]])
        document.select(0, 1)
        SampleEdits.remove(document)
        document.undo()
        expect(document.canRedo).toBe(true)
        document.select(3, 4)
        SampleEdits.silence(document)
        expect(document.canRedo).toBe(false)
    })
    test("undo and redo on empty stacks do nothing", () => {
        const document = documentOf([[1, 2]])
        document.undo()
        document.redo()
        expect(values(document)).toEqual([1, 2])
    })
    test("markSaved clears the unsaved state at the current step", () => {
        const document = documentOf([[1, 2, 3]])
        document.select(0, 1)
        SampleEdits.silence(document)
        document.markSaved(source, "Saved")
        expect(document.hasUnsavedChanges).toBe(false)
        expect(document.name).toBe("Saved")
        document.undo()
        expect(document.hasUnsavedChanges).toBe(true)
        document.redo()
        expect(document.hasUnsavedChanges).toBe(false)
    })
    test("observers hear edits and undo", () => {
        const document = documentOf([[1, 2, 3]])
        let count = 0
        document.subscribe(() => count++)
        document.select(0, 1)
        SampleEdits.remove(document)
        document.undo()
        expect(count).toBe(2)
    })
    test("a whole sample replacement with another channel count undoes", () => {
        const document = documentOf([[1, 2], [3, 4]])
        document.replace(0, 2, create([[2, 3]]), {from: 0, to: 2})
        expect(document.audio.numberOfChannels).toBe(1)
        document.undo()
        expect(document.audio.numberOfChannels).toBe(2)
        expect(values(document, 1)).toEqual([3, 4])
    })
})

describe("SampleEdits", () => {
    test("copy needs a selection", () => {
        const document = documentOf([[1, 2, 3]])
        expect(SampleEdits.copy(document).isEmpty()).toBe(true)
        document.select(1, 3)
        expect(Array.from(SampleEdits.copy(document).unwrap().frames[0])).toEqual([2, 3])
        expect(values(document)).toEqual([1, 2, 3])
    })
    test("cut copies and removes", () => {
        const document = documentOf([[1, 2, 3, 4]])
        document.select(1, 3)
        const clip = SampleEdits.cut(document).unwrap()
        expect(Array.from(clip.frames[0])).toEqual([2, 3])
        expect(values(document)).toEqual([1, 4])
    })
    test("paste inserts at the cursor and selects the inserted range", () => {
        const document = documentOf([[1, 2, 3]])
        document.select(1, 1)
        SampleEdits.paste(document, create([[8, 9]]))
        expect(values(document)).toEqual([1, 8, 9, 2, 3])
        expect(document.selection.getValue()).toEqual({from: 1, to: 3})
    })
    test("paste replaces the selection", () => {
        const document = documentOf([[1, 2, 3, 4]])
        document.select(1, 3)
        SampleEdits.paste(document, create([[9]]))
        expect(values(document)).toEqual([1, 9, 4])
    })
    test("paste at the end appends", () => {
        const document = documentOf([[1, 2]])
        document.select(2, 2)
        SampleEdits.paste(document, create([[3]]))
        expect(values(document)).toEqual([1, 2, 3])
    })
    test("paste converts the channel count", () => {
        const document = documentOf([[1, 2], [3, 4]])
        document.select(0, 0)
        SampleEdits.paste(document, create([[7]]))
        expect(values(document, 0)).toEqual([7, 1, 2])
        expect(values(document, 1)).toEqual([7, 3, 4])
    })
    test("paste refuses another sample rate and an empty clip", () => {
        const document = documentOf([[1, 2]])
        expect(SampleEdits.canPaste(document, create([[1]], 44100))).toBe(false)
        SampleEdits.paste(document, create([[1]], 44100))
        expect(values(document)).toEqual([1, 2])
        expect(SampleEdits.canPaste(document, AudioData.create(48000, 0, 1))).toBe(false)
    })
    test("crop keeps the selection only", () => {
        const document = documentOf([[1, 2, 3, 4]])
        document.select(1, 3)
        SampleEdits.crop(document)
        expect(values(document)).toEqual([2, 3])
        expect(document.selection.getValue()).toEqual({from: 0, to: 2})
        document.undo()
        expect(values(document)).toEqual([1, 2, 3, 4])
    })
    test("crop of everything is no step", () => {
        const document = documentOf([[1, 2]])
        document.selectAll()
        SampleEdits.crop(document)
        expect(document.canUndo).toBe(false)
    })
    test("silence zeroes the selection and keeps the length", () => {
        const document = documentOf([[1, 2, 3]])
        document.select(1, 2)
        SampleEdits.silence(document)
        expect(values(document)).toEqual([1, 0, 3])
    })
    test("edits without a selection do nothing", () => {
        const document = documentOf([[1, 2, 3]])
        SampleEdits.remove(document)
        SampleEdits.crop(document)
        SampleEdits.silence(document)
        expect(document.canUndo).toBe(false)
    })
    test("removing everything leaves an empty sample", () => {
        const document = documentOf([[1, 2, 3]])
        document.selectAll()
        SampleEdits.remove(document)
        expect(document.audio.numberOfFrames).toBe(0)
        expect(document.audio.numberOfChannels).toBe(1)
    })
})
