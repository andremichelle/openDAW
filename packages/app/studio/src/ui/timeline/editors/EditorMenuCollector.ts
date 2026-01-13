import {MenuItem, MenuRootData} from "@moises-ai/studio-core"

export interface EditorMenuCollector {
    viewMenu: MenuItem<MenuRootData>
    editMenu: MenuItem<MenuRootData>
}