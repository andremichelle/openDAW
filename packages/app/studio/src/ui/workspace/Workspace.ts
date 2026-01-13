import {PanelType} from "@/ui/workspace/PanelType.ts"
import {PanelState} from "@/ui/workspace/PanelState.ts"
import {DefaultWorkspace} from "@/ui/workspace/Default.ts"
import {IconSymbol} from "@moises-ai/studio-enums"

export namespace Workspace {
    export type Screen = {
        name: string
        icon: IconSymbol
        content: Content
        hidden?: true
    }
    export type FlexLayoutConstrains = {
        type: "flex"
        minSize: number
        maxSize?: number
        flex: number
    }
    export type FixedLayoutConstrains = {
        type: "fixed"
        fixedSize: number
    }
    export type LayoutConstrains = FlexLayoutConstrains | FixedLayoutConstrains
    export type LayoutConfig = {
        type: "layout"
        orientation: Orientation
        contents: Array<Content>
        constrains: LayoutConstrains
    }
    export type PanelConfig = {
        minimized?: true
        notMinimizable?: true
        notPopoutable?: true
        type: "panel"
        name: string
        icon: IconSymbol
        panelType: PanelType
        constrains: LayoutConstrains
    }
    export type Orientation = "horizontal" | "vertical"
    export type Content = (PanelState | LayoutConfig)

    export const Default = DefaultWorkspace satisfies Record<string, Screen>
    export type ScreenKeys = keyof typeof DefaultWorkspace
}