import {PanelType} from "@/ui/workspace/PanelType.ts"
import {Workspace} from "@/ui/workspace/Workspace.ts"
import {IconSymbol} from "@moises-ai/studio-enums"

export class PanelState {
    static create(schema: Workspace.PanelConfig): PanelState {return new PanelState(schema)}

    readonly type = "panel"
    readonly #panelType: PanelType

    readonly #name: string
    readonly #icon: IconSymbol
    readonly #constrains: Workspace.LayoutConstrains
    readonly #minimizable: boolean
    readonly #popoutable: boolean

    #minimized: boolean

    private constructor(config: Workspace.PanelConfig) {
        this.#panelType = config.panelType
        this.#name = config.name
        this.#icon = config.icon
        this.#constrains = config.constrains
        this.#minimizable = config.notMinimizable !== true
        this.#popoutable = config.notPopoutable !== true
        this.#minimized = config.minimized ?? false
    }

    get panelType(): PanelType {return this.#panelType}
    get name(): string {return this.#name}
    get icon(): IconSymbol {return this.#icon}
    get constrains(): Workspace.LayoutConstrains {return this.#constrains}
    get isMinimized(): boolean {return this.#minimized && this.#minimizable}
    set isMinimized(value: boolean) {this.#minimized = value && this.#minimizable}
    get minimizable(): boolean {return this.#minimizable}
    get popoutable(): boolean {return this.#popoutable}
}