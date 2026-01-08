import {MenuItem, MenuRootData} from "@opendaw/studio-core"

export interface EditorMenuCollector {
    viewMenu: MenuItem<MenuRootData>
    editMenu: MenuItem<MenuRootData>
}