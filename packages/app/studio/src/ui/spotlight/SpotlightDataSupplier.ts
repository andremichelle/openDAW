import {Arrays, assert, Exec} from "@moises-ai/lib-std"

import {IconSymbol} from "@moises-ai/studio-enums"

export type SpotlightResult = {
    name: string
    icon: IconSymbol
    exec: Exec
}

export type SpotlightAction = {
    name: string
    exec: Exec
}

export class SpotlightDataSupplier {
    #actions: Array<SpotlightAction>

    constructor() {
        this.#actions = []
    }

    query(text: string): ReadonlyArray<SpotlightResult> {
        text = text.trim().toLowerCase()
        if (text.length === 0) {return Arrays.empty()}
        return this.#actions.filter(action => action.name.toLowerCase().startsWith(text)).map(({name, exec}) =>
            ({name, icon: IconSymbol.Play, exec}))
        // TODO Search for more entries
    }

    registerAction(name: string, exec: Exec): void {
        assert(-1 === this.#actions.findIndex(action => action.name === name), `${name} already exists`)
        this.#actions.push({name, exec})
    }
}