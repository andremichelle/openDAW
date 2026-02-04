import {
    Arrays,
    Color,
    MutableObservableValue,
    Option,
    Procedure,
    StringMapping,
    Terminable,
    ValueMapping
} from "@opendaw/lib-std"

import {IconSymbol} from "@opendaw/studio-enums"

export type MenuItemOptions = {
    hidden?: boolean
    selectable?: boolean
    separatorBefore?: boolean
}

const Root = {type: "root"} as const

export type HeaderMenuData = {
    type: "header"
    label: string
    icon: IconSymbol
    color?: Color
}

export type DefaultMenuData = {
    type: "default"
    label: string
    shortcut?: string | ReadonlyArray<string>
    checked?: boolean
    icon?: IconSymbol
}

export type InputValueMenuData = {
    type: "input-value"
    icon: IconSymbol
    valueMapping: ValueMapping<number>
    stringMapping: StringMapping<number>
    model: MutableObservableValue<number>
    name: string
    color?: Color
    minValueWidth?: string
}

export type MenuRootData = typeof Root

export type MenuData = (DefaultMenuData & MenuItemOptions) | MenuRootData | HeaderMenuData | InputValueMenuData

export interface MenuCollector {
    addItems(...items: MenuItem[]): void
}

export class MenuItem<DATA extends MenuData = MenuData> {
    static root(): MenuItem<MenuRootData> {return this.#create(Root)}

    static header(properties: Omit<HeaderMenuData, "type"> & MenuItemOptions) {
        return this.#create({type: "header", ...properties}, properties)
    }

    static default(properties: Omit<DefaultMenuData, "type"> & MenuItemOptions) {
        return this.#create({type: "default", ...properties}, properties)
    }

    static inputValue(properties: Omit<InputValueMenuData, "type"> & MenuItemOptions) {
        return this.#create({type: "input-value", ...properties}, properties)
    }

    static #create<D extends MenuData>(data: D, options?: MenuItemOptions): MenuItem<D> {
        return new MenuItem<D>(data, options)
    }

    readonly #data: DATA
    readonly #permanentChildren: MenuItem[]
    readonly #runtimeChildren: MenuItem[]
    readonly #collectors: Array<Procedure<MenuCollector>>

    #runtimeChildrenProcedure: Option<Procedure<MenuItem>> = Option.None
    #openingProcedure: Option<Procedure<MenuItem>> = Option.None
    #triggerProcedure: Option<Procedure<MenuItem>> = Option.None
    #separatorBefore: boolean
    #selectable: boolean
    #hidden: boolean

    #isOpening: boolean = false

    constructor(data: DATA, options?: MenuItemOptions) {
        this.#data = data
        this.#selectable = options?.selectable ?? true
        this.#hidden = options?.hidden ?? false
        this.#separatorBefore = options?.separatorBefore ?? false

        this.#permanentChildren = []
        this.#runtimeChildren = []
        this.#collectors = []
    }

    get data(): DATA {return this.#data}
    get hidden(): boolean {return this.#hidden}
    get selectable(): boolean {return this.#selectable}
    get separatorBefore(): boolean {return this.#separatorBefore}

    get hasChildren(): boolean {
        return this.#permanentChildren.length > 0 || this.#runtimeChildrenProcedure.nonEmpty() || this.#collectors.length > 0
    }

    addMenuItem(...items: ReadonlyArray<MenuItem>): this {
        if (this.#isOpening) {
            this.#runtimeChildren.push(...items)
        } else {
            this.#permanentChildren.push(...items)
        }
        return this
    }

    open(): void {
        this.#openingProcedure.ifSome(procedure => procedure(this))
    }

    trigger(): void {
        try {
            console.debug(`MenuItem.trigger: ${JSON.stringify(this.#data)}`)
        } catch (reason) {
            console.debug(`MenuItem.trigger: ${this.#data}`)
        }
        this.#triggerProcedure.ifSome(procedure => procedure(this))
    }

    isSelectable(value: boolean = true): this {
        this.#selectable = value
        return this
    }

    isHidden(value: boolean = true): this {
        this.#hidden = value
        return this
    }

    addSeparatorBefore(): this {
        this.#separatorBefore = true
        return this
    }

    attach(populator: (collector: MenuCollector) => void): Terminable {
        this.#collectors.push(populator)
        return {terminate: () => Arrays.remove(this.#collectors, populator)}
    }

    setRuntimeChildrenProcedure(procedure: Procedure<MenuItem>): this {
        this.#runtimeChildrenProcedure = Option.wrap(procedure)
        return this
    }

    setOpeningProcedure(procedure: Procedure<MenuItem>): this {
        this.#openingProcedure = Option.wrap(procedure)
        return this
    }

    setTriggerProcedure(procedure: Procedure<MenuItem>): this {
        this.#triggerProcedure = Option.wrap(procedure)
        return this
    }

    collectChildren(): MenuItem[] {
        if (this.#runtimeChildrenProcedure.isEmpty() && this.#collectors.length === 0) {
            return this.#permanentChildren
        }
        this.#isOpening = true
        if (this.#collectors.length > 0) {
            let separatorBefore = false
            this.#collectors.forEach(collector => collector({
                addItems: (...items) => {
                    items.forEach((item: MenuItem) => {
                        if (separatorBefore) {item.addSeparatorBefore()}
                        this.#runtimeChildren.push(item)
                        separatorBefore = false
                    })
                    separatorBefore = true
                }
            }))
        }
        this.#runtimeChildrenProcedure.ifSome(procedure => procedure(this))
        this.#isOpening = false
        return this.#permanentChildren.concat(this.#runtimeChildren)
    }

    clearRuntimeProcedure(): void {
        this.removeRuntimeChildren()
        this.#runtimeChildrenProcedure = Option.None
    }

    removeRuntimeChildren(): void {
        Arrays.clear(this.#runtimeChildren)
    }
}