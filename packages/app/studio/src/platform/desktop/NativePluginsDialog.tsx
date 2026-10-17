import css from "./NativePluginsDialog.sass?inline"
import {Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {NativePluginHost} from "@/platform/desktop/NativePluginHost"
import {Shell} from "@/platform/desktop/Shell"

const className = Html.adoptStyleSheet(css, "NativePluginsDialog")

const StatusText = {
    ok: "Ready",
    failed: "could not be read",
    incompatible: "not built for this computer",
    crashed: "crashed while loading"
} as const

const KindText = {instrument: "Instrument", effect: "Effect", "": ""} as const

export const openNativePluginsDialog = (): void => {
    const lifecycle = new Terminator()
    const folderList: HTMLElement = <div className="folders"/>
    const summary: HTMLElement = <span className="summary"/>
    const pluginList: HTMLElement = <div className="plugins"/>
    const render = (): void => {
        const folders = NativePluginHost.folders()
        replaceChildren(folderList, folders.length === 0
            ? <span className="empty">No folders of your own</span>
            : folders.map(folder => (
                <div className="folder">
                    <span className="path" title={folder}>{folder}</span>
                    <span className="remove" onclick={() => NativePluginHost.setFolders(folders.filter(other => other !== folder))}>Remove</span>
                </div>
            )))
        const plugins = NativePluginHost.plugins()
        summary.textContent = NativePluginHost.isScanning()
            ? "Scanning…"
            : `${plugins.filter(plugin => plugin.status === "ok").length} plugins`
        const ordered = [...plugins.filter(plugin => plugin.status === "ok"), ...plugins.filter(plugin => plugin.status !== "ok")]
        replaceChildren(pluginList, [
            <div className="plugin header">
                <span>Name</span>
                <span>Vendor</span>
                <span>Type</span>
                <span>Status</span>
            </div>,
            ...ordered.map(plugin => (
            <div className={Html.buildClassList("plugin", plugin.status !== "ok" && "problem")} title={plugin.path}>
                <span className="name">{plugin.name}</span>
                <span className="vendor">{plugin.vendor}</span>
                <span className="kind">{KindText[plugin.kind]}</span>
                <span className="status">{StatusText[plugin.status]}</span>
            </div>
        ))])
    }
    lifecycle.own(NativePluginHost.subscribeCatalogue(render))
    render()
    const addFolder = async (): Promise<void> => {
        const response = await Shell.request("pick-folder", {})
        if (response.status !== 200) {return}
        const folder = await response.text()
        const folders = NativePluginHost.folders()
        if (!folders.includes(folder)) {NativePluginHost.setFolders([...folders, folder])}
    }
    const dialog: HTMLDialogElement = (
        <Dialog headline="Plugins"
                icon={IconSymbol.Piano}
                cancelable={true}
                growWidth={true}
                style={{width: "min(48em, 90vw)"}}
                buttons={[
                    {text: "Add Folder…", onClick: () => {addFolder().catch(error => console.warn("[NativePluginsDialog]", error))}},
                    {text: "Rescan", onClick: () => NativePluginHost.rescan(true)},
                    {text: "Close", primary: true, onClick: handler => handler.close()}
                ]}>
            <div className={className}>
                <h2>Your Folders</h2>
                <p>The system's VST3 folders are always scanned.</p>
                {folderList}
                <h2>Found {summary}</h2>
                {pluginList}
            </div>
        </Dialog>
    )
    dialog.addEventListener("close", () => lifecycle.terminate())
    Surface.get().body.appendChild(dialog)
    dialog.showModal()
}
