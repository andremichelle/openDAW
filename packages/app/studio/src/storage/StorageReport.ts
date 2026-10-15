import {StorageScan} from "./StorageScan"

export namespace StorageReport {
    export type Tab = "projects" | "assets" | "templates" | "presets" | "scripts" | "models" | "other"

    export const Tabs: ReadonlyArray<{ tab: Tab, label: string }> = [
        {tab: "projects", label: "Projects"},
        {tab: "assets", label: "Assets"},
        {tab: "templates", label: "Templates"},
        {tab: "presets", label: "Presets"},
        {tab: "scripts", label: "Scripts"},
        {tab: "models", label: "Models"},
        {tab: "other", label: "Other"}
    ]

    const ItemKinds: Record<Exclude<Tab, "assets" | "other">, ReadonlyArray<StorageScan.ItemKind>> = {
        projects: ["project"],
        templates: ["template"],
        presets: ["preset"],
        scripts: ["script"],
        models: ["model", "nam-pack"]
    }

    export const itemsOf = (report: StorageScan.Report, tab: Exclude<Tab, "assets" | "other">): ReadonlyArray<StorageScan.Item> =>
        report.items.filter(({kind}) => ItemKinds[tab].includes(kind)).toSorted((a, b) => b.size - a.size)

    export const countOf = (report: StorageScan.Report, tab: Tab): number => {
        switch (tab) {
            case "assets":
                return report.assets.length
            case "other":
                return report.other.length
            default:
                return itemsOf(report, tab).length
        }
    }

    export const keyOf = ({kind, id}: { kind: string, id: string }): string => `${kind}:${id}`

    export const summarize = (names: ReadonlyArray<string>, max: number = 3): string =>
        names.length <= max ? names.join(", ") : `${names.slice(0, max - 1).join(", ")} and ${names.length - max + 1} others`

    export const isSame = (a: { kind: string, id: string }, b: { kind: string, id: string }): boolean =>
        a.kind === b.kind && a.id === b.id

    export const withoutAsset = (report: StorageScan.Report, ref: StorageScan.AssetRef): StorageScan.Report => ({
        ...report,
        total: report.total - (report.assets.find(asset => isSame(asset, ref))?.size ?? 0),
        assets: report.assets.filter(asset => !isSame(asset, ref)),
        items: report.items.map(item => ({...item, uses: item.uses.filter(use => !isSame(use, ref))}))
    })

    export const withoutItem = (report: StorageScan.Report, ref: StorageScan.ItemRef): StorageScan.Report => ({
        ...report,
        total: report.total - (report.items.find(item => isSame(item, ref))?.size ?? 0),
        items: report.items.filter(item => !isSame(item, ref)),
        assets: report.assets.map(asset => ({...asset, usedBy: asset.usedBy.filter(user => !isSame(user, ref))}))
    })

    // assets nothing but this item uses, so deleting the item leaves them unused
    export const orphansOf = (report: StorageScan.Report, ref: StorageScan.ItemRef): ReadonlyArray<StorageScan.Asset> =>
        report.assets.filter(({usedBy}) => usedBy.length > 0 && usedBy.every(user => isSame(user, ref)))

    // the open project's unsaved state counts as a user too, its saved file may not know its latest assets yet
    export const withOpenProject = (report: StorageScan.Report, projectId: string,
                                    refs: ReadonlyArray<StorageScan.AssetRef>): StorageScan.Report => {
        const owner: StorageScan.ItemRef = {kind: "project", id: projectId}
        const live = new Set(refs.map(keyOf))
        return {
            ...report,
            assets: report.assets.map(asset => live.has(keyOf(asset)) && !asset.usedBy.some(ref => keyOf(ref) === keyOf(owner))
                ? {...asset, usedBy: [...asset.usedBy, owner]} : asset)
        }
    }
}
