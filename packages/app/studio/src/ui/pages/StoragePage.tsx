import css from "./StoragePage.sass?inline"
import {
    Bytes, DefaultObservableValue, EmptyExec, MutableObservableOption, Option, RuntimeNotifier, Terminator, UUID
} from "@opendaw/lib-std"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {StorageScan} from "@/storage/StorageScan"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {WclapStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {BackButton} from "@/ui/pages/BackButton"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {StorageInspector} from "@/storage/StorageInspector"
import {StorageReport} from "@/storage/StorageReport"
import {StorageDeletion} from "@/storage/StorageDeletion"
import {DeleteUnusedDialog} from "@/ui/pages/DeleteUnusedDialog"
import {WclapDescriber} from "@/service/WclapDescriber"

const className = Html.adoptStyleSheet(css, "StoragePage")

const nameWclaps = async (report: StorageScan.Report): Promise<StorageScan.Report> => ({
    ...report, assets: await Promise.all(report.assets.map(async asset => {
        if (asset.kind !== "wclap") {return asset}
        const plugins = await WclapDescriber.describe(WclapStorage.urlOf(asset.id)).catch(() => [])
        return plugins.length === 0 ? asset : {...asset, name: plugins.map(({name}) => name).join(", ")}
    }))
})

const Consequence = "This cannot be undone. With the cloud backup on, it is removed there on the next sync too."

const KindLabels: Record<StorageScan.AssetKind | StorageScan.ItemKind, string> = {
    "sample": "Sample", "soundfont": "Soundfont", "wclap": "WebCLAP", "project": "Project", "template": "Template",
    "preset": "Preset", "script": "Script", "model": "Model", "nam-pack": "NAM Pack"
}

export const StoragePage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const tab = new DefaultObservableValue<StorageReport.Tab>("projects")
    const reportTerminator = lifecycle.own(new Terminator())
    const listTerminator = lifecycle.own(new Terminator())
    const playback = service.samplePlayback
    lifecycle.own({terminate: () => playback.eject()})
    const summary: HTMLElement = <div className="summary"/>
    const tabs: HTMLElement = <div className="tabs"/>
    const list: HTMLElement = <div className="list"/>
    const current = new MutableObservableOption<StorageScan.Report>()
    const openProjectId = (): Option<string> =>
        service.projectProfileService.getValue().map(profile => UUID.toString(profile.uuid))
    const isOpenProject = ({kind, id}: StorageScan.ItemRef): boolean => kind === "project" && openProjectId().contains(id)
    const nameOf = (report: StorageScan.Report, ref: StorageScan.ItemRef): string =>
        report.items.find(item => StorageReport.isSame(item, ref))?.name ?? (isOpenProject(ref) ? "open project" : ref.id)
    const confirm = (headline: string, message: string, approveText: string = "Delete", cancelText: string = "Cancel") =>
        RuntimeNotifier.approve({headline, message, approveText, cancelText})
    const update = (report: StorageScan.Report): void => {
        current.wrap(report)
        renderReport(report)
    }
    const removeAsset = async (asset: StorageScan.Asset): Promise<void> => {
        const report = current.unwrap("no report")
        if (asset.usedBy.some(isOpenProject)) {
            return RuntimeNotifier.info({
                headline: "In Use", message: `'${asset.name}' is used by the open project. Remove it there first.`
            })
        }
        const users = asset.usedBy.map(ref => nameOf(report, ref)).join(", ")
        if (asset.usedBy.length > 0 && !await confirm("Still In Use",
            `'${asset.name}' is used by ${users}. They will miss it after the deletion.`, "Continue")) {return}
        const reload = asset.origin === "openDAW" ? " It can be downloaded again from the openDAW library." : ""
        if (!await confirm(`Delete ${KindLabels[asset.kind]}`,
            `'${asset.name}' (${Bytes.toString(asset.size)})\n${Consequence}${reload}`)) {return}
        if (asset.kind === "sample") {playback.eject()}
        const result = await Promises.tryCatch(StorageDeletion.deleteAsset(asset))
        if (result.status === "rejected") {
            return RuntimeNotifier.info({headline: "Could not delete", message: String(result.error)})
        }
        update(StorageReport.withoutAsset(report, asset))
    }
    const removeItem = async (item: StorageScan.Item): Promise<void> => {
        const report = current.unwrap("no report")
        if (isOpenProject(item)) {
            return RuntimeNotifier.info({headline: "Project Is Open", message: "Close the project before deleting it."})
        }
        if (!await confirm(`Delete ${KindLabels[item.kind]}`,
            `'${item.name}' (${Bytes.toString(item.size)})\n${Consequence}`)) {return}
        const result = await Promises.tryCatch(StorageDeletion.deleteItem(service, item))
        if (result.status === "rejected") {
            return RuntimeNotifier.info({headline: "Could not delete", message: String(result.error)})
        }
        const orphans = StorageReport.orphansOf(report, item)
        const deleted: Array<StorageScan.Asset> = []
        if (orphans.length > 0 && await confirm("Delete Unused Assets?",
            `${orphans.length} asset${orphans.length === 1 ? " was" : "s were"} only used by '${item.name}' `
            + `(${Bytes.toString(StorageReport.sizeOf(orphans))}):\n`
            + `${orphans.slice(0, 8).map(({name}) => name).join(", ")}${orphans.length > 8 ? ", ..." : ""}\n${Consequence}`,
            "Delete them", "Keep them")) {
            for (const orphan of orphans) {
                if ((await Promises.tryCatch(StorageDeletion.deleteAsset(orphan))).status === "resolved") {deleted.push(orphan)}
            }
        }
        update(deleted.reduce(StorageReport.withoutAsset, StorageReport.withoutItem(report, item)))
    }
    const removeUnused = async (): Promise<void> => {
        const report = current.unwrap("no report")
        const selection = await Promises.tryCatch(DeleteUnusedDialog.show(StorageReport.unusedOf(report), Consequence))
        if (selection.status === "rejected" || selection.value.length === 0) {return}
        const assets = selection.value
        if (assets.some(({kind}) => kind === "sample")) {playback.eject()}
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Deleting Unused", message: "", progress})
        const deleted: Array<StorageScan.Asset> = []
        const failed: Array<string> = []
        for (const [index, asset] of assets.entries()) {
            dialog.message = asset.name
            const result = await Promises.tryCatch(StorageDeletion.deleteAsset(asset))
            if (result.status === "resolved") {deleted.push(asset)} else {failed.push(`${asset.name}: ${String(result.error)}`)}
            progress.setValue((index + 1) / assets.length)
        }
        dialog.terminate()
        update(deleted.reduce(StorageReport.withoutAsset, report))
        if (failed.length > 0) {
            return RuntimeNotifier.info({
                headline: "Could not delete",
                message: `${failed.length} of ${assets.length} could not be deleted:\n${failed.join("\n")}`
            })
        }
    }
    const deleteButton = (procedure: () => Promise<void>): HTMLElement => {
        const element: HTMLElement = <div className="delete" title="Delete"><Icon symbol={IconSymbol.Delete}/></div>
        listTerminator.own(Events.subscribe(element, "click", () => procedure().then(EmptyExec)))
        return element
    }
    const preview = (asset: StorageScan.Asset): HTMLElement => {
        if (asset.kind !== "sample") {return <span className="preview"/>}
        const element: HTMLElement = <span className="preview" title="Play / Stop"><Icon symbol={IconSymbol.Play}/></span>
        listTerminator.ownAll(
            playback.subscribe(asset.id, event => {
                element.classList.remove("buffering", "playing", "error")
                element.classList.add(event.type)
            }),
            Events.subscribe(element, "click", () => playback.toggle(asset.id)))
        return element
    }
    const renderList = (report: StorageScan.Report): void => {
        listTerminator.terminate()
        Html.empty(list)
        const assetSize = new Map(report.assets.map(asset => [StorageReport.keyOf(asset), asset.size]))
        const current = tab.getValue()
        if (current === "assets") {
            list.className = "list assets"
            list.append(<h4>Name</h4>, <h4>Kind</h4>, <h4>Size</h4>, <h4>Used by</h4>, <h4/>)
            report.assets.toSorted((a, b) => b.size - a.size).forEach(asset => list.append(
                <div className="name" title={asset.id}>{preview(asset)}<span>{asset.name}</span></div>,
                <div className="kind">{KindLabels[asset.kind]}</div>,
                <div className="size">{Bytes.toString(asset.size)}</div>,
                asset.usedBy.length === 0
                    ? <div className="unused">unused</div>
                    : <div className="users" title={asset.usedBy.map(ref => nameOf(report, ref)).join("\n")}>
                        {StorageReport.summarize(asset.usedBy.map(ref => nameOf(report, ref)))}
                    </div>,
                deleteButton(() => removeAsset(asset))))
        } else if (current === "other") {
            list.className = "list other"
            list.append(<h4>Path</h4>, <h4>Size</h4>)
            report.other.toSorted((a, b) => b.size - a.size).forEach(({path, size}) => list.append(
                <div className="name">{path}</div>,
                <div className="size">{Bytes.toString(size)}</div>))
        } else {
            list.className = "list items"
            list.append(<h4>Name</h4>, <h4>Kind</h4>, <h4>Size</h4>, <h4>Uses</h4>, <h4/>)
            StorageReport.itemsOf(report, current).forEach(item => {
                const used = item.uses.reduce((sum, ref) => sum + (assetSize.get(StorageReport.keyOf(ref)) ?? 0), 0)
                const isOpen = isOpenProject(item)
                list.append(
                    <div className="name" title={item.id}>{item.name}{isOpen ? <span className="open">open</span> : ""}</div>,
                    <div className="kind">{KindLabels[item.kind]}</div>,
                    <div className="size">{Bytes.toString(item.size)}</div>,
                    <div className="uses">
                        {item.uses.length === 0 ? "" : `${item.uses.length} asset${item.uses.length === 1 ? "" : "s"} (${Bytes.toString(used)})`}
                        {item.notStored.length > 0 ? <span className="not-stored">{`${item.notStored.length} not stored here`}</span> : ""}
                    </div>,
                    deleteButton(() => removeItem(item)))
            })
        }
        if (StorageReport.countOf(report, current) === 0) {list.append(<div className="empty">Nothing stored</div>)}
    }
    const renderReport = (report: StorageScan.Report): void => {
        reportTerminator.terminate()
        Html.empty(summary)
        const unused = StorageReport.unusedOf(report)
        summary.append(
            <span>{`openDAW files: ${Bytes.toString(report.total)}`}</span>,
            <span className="estimate"/>,
            report.failures.length > 0
                ? <span className="failures" title={report.failures.join("\n")}>{`${report.failures.length} unreadable`}</span>
                : <span/>,
            unused.length === 0 ? <span/> : (
                <Button lifecycle={reportTerminator} onClick={() => removeUnused().then(EmptyExec)}
                        appearance={{color: Colors.red, framed: true}}>
                    <span>{`Delete unused (${unused.length}, ${Bytes.toString(StorageReport.sizeOf(unused))})...`}</span>
                </Button>
            ),
            <Button lifecycle={reportTerminator} onClick={() => scan()} appearance={{color: Colors.blue, framed: true}}>
                <span>Rescan</span>
            </Button>)
        navigator.storage.estimate().then(({usage, quota}) => {
            const estimate = summary.querySelector("span.estimate")
            if (estimate !== null && usage !== undefined && quota !== undefined) {
                estimate.textContent = `all site data: ${Bytes.toString(usage)} of ${Bytes.toString(quota)} allowed`
            }
        })
        Html.empty(tabs)
        tabs.append(<RadioGroup lifecycle={reportTerminator} model={tab} appearance={{framed: true}}
                                elements={StorageReport.Tabs.map(({tab, label}) => ({
                                    value: tab,
                                    element: <span>{`${label} (${StorageReport.countOf(report, tab)})`}</span>
                                }))}/>)
        reportTerminator.own(tab.catchupAndSubscribe(() => renderList(report)))
    }
    const scan = async (): Promise<void> => {
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Scanning Storage", message: "Listing files", progress})
        const result = await Promises.tryCatch(StorageInspector.scan(
            count => dialog.message = `Listing files (${count})`,
            value => {
                dialog.message = "Reading projects, templates and presets"
                progress.setValue(value)
            }))
        dialog.terminate()
        if (result.status === "rejected") {
            return RuntimeNotifier.info({headline: "Could not scan the storage", message: String(result.error)})
        }
        const report = service.projectProfileService.getValue().match({
            none: () => result.value,
            some: profile => StorageReport.withOpenProject(result.value, UUID.toString(profile.uuid),
                StorageScan.referencesOf(profile.project.boxGraph).refs)
        })
        update(await nameWclaps(report))
    }
    scan().then(EmptyExec)
    return (
        <div className={className}>
            <BackButton lifecycle={lifecycle} service={service}/>
            <h1>Storage</h1>
            <p className="disclaimer">
                This page only covers the storage of this browser (OPFS). It knows nothing about your work anywhere
                else: backups, exported bundles, project files on disk, the cloud or other browsers. An asset listed
                as unused here may still be needed by any of those. Delete with care.
            </p>
            {summary}
            {tabs}
            <div className="list-wrapper">{list}</div>
        </div>
    )
}
