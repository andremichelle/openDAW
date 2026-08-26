import {Project, ModulatorsClipboard} from "@opendaw/studio-core"

/// The panel, its editors and the shortcuts all drive the same clipboard, so they build its context here.
export namespace ModulatorClipboardContext {
    export const of = (project: Project): ModulatorsClipboard.Context => ({
        getEnabled: () => true,
        editing: project.editing,
        selection: project.modulatorSelection,
        boxGraph: project.boxGraph,
        boxAdapters: project.boxAdapters,
        rootBoxAdapter: () => project.rootBoxAdapter
    })
}
