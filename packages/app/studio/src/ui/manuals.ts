import {EmptyExec, Option} from "@opendaw/lib-std"

// A host that installs parts of the studio on demand (the desktop app's optional components)
export interface ComponentHost {
    ensure(component: string): Promise<void>
}

const state: { host: Option<ComponentHost> } = {host: Option.None}

export const installComponentHost = (host: ComponentHost): void => {state.host = Option.wrap(host)}

const open = (component: string, path: string, target: string): void => state.host.match({
    none: () => {window.open(path, target)},
    some: host => host.ensure(component).then(() => {window.open(path, target)}, EmptyExec)
})

export const openManual = (path: string): void => open("manuals", path, "manuals")
export const openScriptingDocs = (): void => open("docs", "/docs/scripting/", "_blank")
