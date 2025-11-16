import {FieldKey} from "@opendaw/lib-box"

export interface Field {
    get path(): FieldKey[]
}

export namespace Field {
    export const object = <T extends Record<string, Field>>(parent: Field,
                                                            fieldKey: FieldKey,
                                                            factory: (self: Field) => T): T & Field => {
        const self: Field = {get path(): FieldKey[] {return [...parent.path, fieldKey]}}
        const fields = factory(self)
        return Object.assign(self, fields) as T & Field
    }

    export const array = <T extends Field>(parent: Field,
                                           fieldKey: FieldKey,
                                           length: FieldKey,
                                           factory: (self: Field, index: FieldKey) => T
    ): (ReadonlyArray<T> & Field) => {
        const self: Field = {get path(): FieldKey[] {return [...parent.path, fieldKey]}}
        const elements = Array.from({length}, (_, i) => factory(self, i))
        return Object.assign(elements, self) as T[] & Field
    }
}