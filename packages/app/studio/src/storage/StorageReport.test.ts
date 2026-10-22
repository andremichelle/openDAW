import {describe, expect, it} from "vitest"
import {StorageScan} from "./StorageScan"
import {StorageReport} from "./StorageReport"

const asset = (id: string, usedBy: ReadonlyArray<StorageScan.ItemRef>): StorageScan.Asset => ({
    kind: "sample", id, name: id, size: 10, path: `samples/v2/${id}`, origin: null, clapIds: [], usedBy
})

const item = (kind: StorageScan.ItemKind, id: string, size: number): StorageScan.Item => ({
    kind, id, name: id, size, path: id, uses: [], notStored: []
})

const report: StorageScan.Report = {
    total: 0, bookkeeping: 0, failures: [],
    assets: [asset("a", [{kind: "project", id: "p1"}]), asset("b", [])],
    items: [item("project", "p1", 5), item("project", "p2", 50), item("model", "m", 1), item("nam-pack", "n", 2)],
    other: [{path: ".backup/project.od", size: 3}]
}

describe("StorageReport", () => {
    it("adds the open project as a user of the assets its live graph refers to", () => {
        const result = StorageReport.withOpenProject(report, "p2", [{kind: "sample", id: "a"}, {kind: "sample", id: "b"}])
        expect(result.assets.map(({usedBy}) => usedBy)).toEqual([
            [{kind: "project", id: "p1"}, {kind: "project", id: "p2"}],
            [{kind: "project", id: "p2"}]
        ])
    })

    it("does not list the open project twice", () => {
        const result = StorageReport.withOpenProject(report, "p1", [{kind: "sample", id: "a"}])
        expect(result.assets[0].usedBy).toEqual([{kind: "project", id: "p1"}])
    })

    it("groups items per tab, largest first", () => {
        expect(StorageReport.itemsOf(report, "projects").map(({id}) => id)).toEqual(["p2", "p1"])
        expect(StorageReport.itemsOf(report, "models").map(({id}) => id)).toEqual(["n", "m"])
        expect(StorageReport.Tabs.map(({tab}) => StorageReport.countOf(report, tab))).toEqual([2, 2, 0, 0, 0, 2, 1])
    })

    it("drops a deleted asset from the report and from its users", () => {
        const withUse = {...report, items: report.items.map(item => item.id === "p1" ? {...item, uses: [{kind: "sample" as const, id: "a"}]} : item)}
        const result = StorageReport.withoutAsset({...withUse, total: 100}, {kind: "sample", id: "a"})
        expect(result.assets.map(({id}) => id)).toEqual(["b"])
        expect(result.items.find(({id}) => id === "p1")?.uses).toEqual([])
        expect(result.total).toBe(90)
    })

    it("drops a deleted item from the report and from the assets it used", () => {
        const result = StorageReport.withoutItem({...report, total: 100}, {kind: "project", id: "p1"})
        expect(result.items.map(({id}) => id)).toEqual(["p2", "m", "n"])
        expect(result.assets[0].usedBy).toEqual([])
        expect(result.total).toBe(95)
    })

    it("finds the assets only the deleted item uses, never unused or shared ones", () => {
        const shared = StorageReport.withOpenProject(report, "p2", [{kind: "sample", id: "a"}])
        expect(StorageReport.orphansOf(report, {kind: "project", id: "p1"}).map(({id}) => id)).toEqual(["a"])
        expect(StorageReport.orphansOf(shared, {kind: "project", id: "p1"})).toEqual([])
        expect(StorageReport.orphansOf(report, {kind: "project", id: "p2"})).toEqual([])
    })

    it("lists unused assets grouped by kind, largest first", () => {
        const assets: ReadonlyArray<StorageScan.Asset> = [
            {...asset("w", []), kind: "wclap", size: 99},
            {...asset("s1", []), size: 5},
            {...asset("used", [{kind: "preset", id: "x"}]), size: 1000},
            {...asset("f", []), kind: "soundfont", size: 1},
            {...asset("s2", []), size: 50}
        ]
        const unused = StorageReport.unusedOf({...report, assets})
        expect(unused.map(({id}) => id)).toEqual(["s2", "s1", "f", "w"])
        expect(StorageReport.sizeOf(unused)).toBe(155)
        expect(StorageReport.sizeOf([])).toBe(0)
    })

    it("never lists an asset the open project uses as unused", () => {
        expect(StorageReport.unusedOf(report).map(({id}) => id)).toEqual(["b"])
        expect(StorageReport.unusedOf(StorageReport.withOpenProject(report, "p2", [{kind: "sample", id: "b"}]))).toEqual([])
    })

    it("lists an asset as unused once its only user is deleted", () => {
        expect(StorageReport.unusedOf(StorageReport.withoutItem(report, {kind: "project", id: "p1"}))
            .map(({id}) => id)).toEqual(["a", "b"])
    })

    it("summarizes long user lists", () => {
        expect(StorageReport.summarize(["A"])).toBe("A")
        expect(StorageReport.summarize(["A", "B", "C"])).toBe("A, B, C")
        expect(StorageReport.summarize(["A", "B", "C", "D"])).toBe("A, B and 2 others")
        expect(StorageReport.summarize(["A", "B", "C", "D", "E"])).toBe("A, B and 3 others")
    })
})
