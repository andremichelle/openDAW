import {describe, expect, it} from "vitest"
import {FolderImport} from "./FolderImport"

// Minimal stand-ins for the browser's FileSystemEntry API. Directories hand out their children in batches of
// two, so the test also covers the readEntries loop that has to keep reading until an empty batch arrives.
const fileEntry = (name: string): FileSystemFileEntry => ({
    name, isFile: true, isDirectory: false,
    file: (resolve: (file: File) => void) => resolve(new File(["x"], name))
}) as unknown as FileSystemFileEntry

const directoryEntry = (name: string, children: ReadonlyArray<FileSystemEntry>): FileSystemDirectoryEntry => ({
    name, isFile: false, isDirectory: true,
    createReader: () => {
        let offset = 0
        return {
            readEntries: (resolve: (entries: ReadonlyArray<FileSystemEntry>) => void) => {
                resolve(children.slice(offset, offset + 2))
                offset += 2
            }
        }
    }
}) as unknown as FileSystemDirectoryEntry

const summary = (entries: ReadonlyArray<FolderImport.Entry>) =>
    entries.map(({file, folder}) => `${folder}|${file.name}`)

describe("FolderImport.fromEntries", () => {
    it("keeps the folder path of every file, including the dropped folder itself", async () => {
        const dropped = directoryEntry("grime", [
            directoryEntry("BitzNFX", [fileEntry("fx1.wav"), fileEntry("fx2.wav"), fileEntry("fx3.wav")]),
            directoryEntry("Kits", [
                directoryEntry("03", [fileEntry("loop.wav"), directoryEntry("DrumHits", [fileEntry("kick.wav")])])
            ])
        ])
        expect(summary(await FolderImport.fromEntries([dropped]))).toEqual([
            "grime/BitzNFX|fx1.wav",
            "grime/BitzNFX|fx2.wav",
            "grime/BitzNFX|fx3.wav",
            "grime/Kits/03|loop.wav",
            "grime/Kits/03/DrumHits|kick.wav"
        ])
    })
    it("puts loose files at the drop target and skips hidden files and folders", async () => {
        const entries = await FolderImport.fromEntries([
            fileEntry("snare.wav"),
            fileEntry(".DS_Store"),
            directoryEntry("kit", [fileEntry("._kick.wav"), directoryEntry(".git", [fileEntry("x.wav")])])
        ])
        expect(summary(entries)).toEqual(["|snare.wav"])
    })
    it("tells a folder drop from a plain file drop", () => {
        expect(FolderImport.hasFolder([fileEntry("a.wav")])).toBe(false)
        expect(FolderImport.hasFolder([fileEntry("a.wav"), directoryEntry("kit", [])])).toBe(true)
    })
})

describe("FolderImport.fromRelativePaths", () => {
    const withPath = (path: string): File => {
        const file = new File(["x"], path.split("/").at(-1) ?? path)
        Object.defineProperty(file, "webkitRelativePath", {value: path})
        return file
    }
    it("derives the folder from the path the folder picker reports", () => {
        expect(summary(FolderImport.fromRelativePaths([
            withPath("grime/Kits/03/DrumHits/kick.wav"),
            withPath("grime/Kits/.DS_Store"),
            withPath("grime/top.wav")
        ]))).toEqual(["grime/Kits/03/DrumHits|kick.wav", "grime|top.wav"])
    })
})

describe("FolderImport.byFolder", () => {
    it("groups files by folder in first-seen order", () => {
        const file = (name: string) => new File(["x"], name)
        const groups = FolderImport.byFolder([
            {file: file("a.wav"), folder: "kit/01"},
            {file: file("b.wav"), folder: "kit/02"},
            {file: file("c.wav"), folder: "kit/01"}
        ])
        expect(groups.map(([folder, files]) => [folder, files.map(entry => entry.name)]))
            .toEqual([["kit/01", ["a.wav", "c.wav"]], ["kit/02", ["b.wav"]]])
    })
})
