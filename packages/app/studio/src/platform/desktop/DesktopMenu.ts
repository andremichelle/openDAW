import {isDefined, Optional} from "@opendaw/lib-std"
import {Shortcut} from "@opendaw/lib-dom"
import {MenuItem} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {DesktopStudioMenu} from "@/service/DesktopStudioMenu"
import {Shell} from "@/platform/desktop/Shell"

type ShellNode =
    | { type: "item", id: string, label: string, enabled: boolean, accelerator?: string }
    | { type: "check", id: string, label: string, enabled: boolean, checked: boolean, accelerator?: string }
    | { type: "submenu", label: string, enabled: boolean, items: ReadonlyArray<ShellNode> }
    | { type: "separator" }
    | { type: "native", role: DesktopStudioMenu.NativeRole }

export namespace DesktopMenu {
    const triggers = new Map<string, MenuItem>()
    const state = {nextId: 0, scheduled: false}

    const KeyNames: Record<string, string> = {Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=", Space: "Space"}

    // DesktopStudioMenu picks which shortcuts are shown as accelerators
    const toAccelerator = (shortcut: Shortcut): Optional<string> => {
        const {code} = shortcut
        const key = code.startsWith("Key") || code.startsWith("Arrow") ? code
            : code.startsWith("Digit") ? code.slice("Digit".length) : KeyNames[code]
        if (!isDefined(key)) {return undefined}
        return [...(shortcut.ctrl ? ["CmdOrCtrl"] : []), ...(shortcut.shift ? ["Shift"] : []), ...(shortcut.alt ? ["Alt"] : []), key].join("+")
    }

    const convert = (item: MenuItem): ReadonlyArray<ShellNode> => {
        const {data} = item
        if (item.hidden || data.type !== "default") {return []}
        const separator: ReadonlyArray<ShellNode> = item.separatorBefore ? [{type: "separator"}] : []
        if (item.hasChildren) {
            item.open()
            const items = item.collectChildren().flatMap(convert)
            item.removeRuntimeChildren()
            return [...separator, {type: "submenu", label: data.label, enabled: item.selectable, items}]
        }
        const id = String(state.nextId++)
        triggers.set(id, item)
        const shortcut = DesktopStudioMenu.shortcuts.get(item)
        const accelerator = isDefined(shortcut) ? toAccelerator(shortcut) : undefined
        return [...separator, isDefined(data.checked)
            ? {type: "check", id, label: data.label, enabled: item.selectable, checked: data.checked, accelerator}
            : {type: "item", id, label: data.label, enabled: item.selectable, accelerator}]
    }

    const toNode = (entry: DesktopStudioMenu.Entry): ReadonlyArray<ShellNode> =>
        typeof entry === "string"
            ? [entry === "separator" ? {type: "separator"} : {type: "native", role: entry}]
            : convert(entry)

    const send = (service: StudioService): void => {
        triggers.clear()
        const bar = DesktopStudioMenu.create(service).map(({label, role, entries}) =>
            ({label, role, items: entries.flatMap(toNode)}))
        Shell.request("menu", {}, JSON.stringify(bar)).catch(error => console.warn("[DesktopMenu]", error))
    }

    export const attach = (service: StudioService): void => {
        const schedule = () => {
            if (state.scheduled) {return}
            state.scheduled = true
            queueMicrotask(() => {
                state.scheduled = false
                send(service)
            })
        }
        Shell.info().menu = (id: string) => {
            triggers.get(id)?.trigger()
            schedule()
        }
        service.projectProfileService.catchupAndSubscribe(schedule)
    }
}
