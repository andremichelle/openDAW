import {beforeEach, describe, expect, it} from "vitest"
import {RuntimeNotification, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Soundfont} from "@opendaw/studio-adapters"
import {SoundfontFileBox} from "@opendaw/studio-boxes"
import {AssetService} from "./AssetService"
import {FilePickerAcceptTypes} from "./FilePickerAcceptTypes"

// A folder import hands its sub-folders over as groups. The user must see one progress dialog for the whole
// import (not one per sub-folder) and, if anything fails, one issue report at the end.

const progressHeadlines: Array<string> = []
const infos: Array<string> = []
RuntimeNotifier.install({
    info: async (request: RuntimeNotification.InfoRequest) => {infos.push(request.message ?? "")},
    approve: async () => true,
    progress: (request: RuntimeNotification.ProgressRequest) => {
        progressHeadlines.push(request.headline ?? "")
        return {message: "", terminate: () => {}}
    },
    notify: () => {}
})

class TestService extends AssetService<Soundfont, void> {
    protected readonly nameSingular: string = "Soundfont"
    protected readonly namePlural: string = "Soundfonts"
    protected readonly boxType = SoundfontFileBox
    protected readonly filePickerOptions: FilePickerOptions = FilePickerAcceptTypes.SoundfontFiles

    acceptsFile(file: File): boolean {return file.name.endsWith(".sf2")}

    async importFile({name}: AssetService.ImportArgs): Promise<Soundfont> {
        if (name === "broken.sf2") {return Promise.reject(new Error("broken"))}
        return {uuid: UUID.toString(UUID.generate()), name: name ?? "", size: 0, url: "unknown", license: "", origin: "import"}
    }

    protected async collectAllFiles(): Promise<ReadonlyArray<Soundfont>> {return []}
}

const fileOf = (name: string): File =>
    ({name, arrayBuffer: async () => new ArrayBuffer(0)}) as unknown as File

const names = (groups: ReadonlyArray<ReadonlyArray<Soundfont>>) =>
    groups.map(group => group.map(({name}) => name))

describe("AssetService.importGroups", () => {
    beforeEach(() => {
        progressHeadlines.length = 0
        infos.length = 0
    })

    it("opens one progress dialog for all groups and keeps the grouping", async () => {
        const groups = await new TestService().importGroups([
            [fileOf("a.sf2"), fileOf("b.sf2")],
            [fileOf("readme.txt")],
            [fileOf("c.sf2")]
        ])
        expect(names(groups)).toEqual([["a.sf2", "b.sf2"], [], ["c.sf2"]])
        expect(progressHeadlines).toEqual(["Importing Soundfonts..."])
        expect(infos).toEqual([])
    })

    it("reports failures of all groups in one message", async () => {
        const groups = await new TestService().importGroups([
            [fileOf("broken.sf2"), fileOf("a.sf2")],
            [fileOf("broken.sf2")]
        ])
        expect(names(groups)).toEqual([["a.sf2"], []])
        expect(progressHeadlines).toHaveLength(1)
        expect(infos).toEqual(["Error: broken, Error: broken could not be imported."])
    })

    it("opens no dialog when no group holds an accepted file", async () => {
        const groups = await new TestService().importGroups([[fileOf("readme.txt")], []])
        expect(names(groups)).toEqual([[], []])
        expect(progressHeadlines).toEqual([])
    })

    it("importFiles still returns a flat list", async () => {
        const imported = await new TestService().importFiles([fileOf("a.sf2"), fileOf("b.sf2")])
        expect(imported.map(({name}) => name)).toEqual(["a.sf2", "b.sf2"])
        expect(progressHeadlines).toHaveLength(1)
    })
})
