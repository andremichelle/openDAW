import {asInstanceOf, EmptyExec, Exec, isDefined, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {Field, Propagation} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ScriptRecordBox, ScriptValueBox} from "@opendaw/studio-boxes"
import {CollectionDeclaration, ParamDeclaration} from "./ScriptDeclaration"

type Hub = Field<Pointers.ScriptRecord>

export type ScriptRecordValues = { readonly [field: string]: number }

const sortedRecords = (hub: Hub, collection: string): Array<ScriptRecordBox> => hub.pointerHub.filter()
    .map(({box}) => asInstanceOf(box, ScriptRecordBox))
    .filter(record => record.collection.getValue() === collection)
    .sort((left, right) => left.order.getValue() - right.order.getValue())

const valueBoxes = (record: ScriptRecordBox): Array<ScriptValueBox> =>
    record.values.pointerHub.filter().map(({box}) => asInstanceOf(box, ScriptValueBox))

const normalize = (field: ParamDeclaration, value: number): number => {
    const clamped = Math.min(field.max, Math.max(field.min, value))
    return field.mapping === "int" || field.mapping === "bool" ? Math.round(clamped) : clamped
}

const createValue = (record: ScriptRecordBox, field: ParamDeclaration, fieldIndex: number, value: number): void => {
    ScriptValueBox.create(record.graph, UUID.generate(), box => {
        box.owner.refer(record.values)
        box.field.setValue(field.label)
        box.fieldIndex.setValue(fieldIndex)
        box.value.setValue(value)
    })
}

// Every edit runs inside the caller's transaction (`editing.modify`).
export namespace ScriptRecords {
    export const create = (hub: Hub, collection: CollectionDeclaration, order: number, values: ReadonlyArray<number>): ScriptRecordBox => {
        const record = ScriptRecordBox.create(hub.box.graph, UUID.generate(), box => {
            box.owner.refer(hub)
            box.collection.setValue(collection.name)
            box.collectionIndex.setValue(collection.index)
            box.order.setValue(order)
        })
        collection.fields.forEach((field, fieldIndex) => createValue(record, field, fieldIndex, values[fieldIndex] ?? field.defaultValue))
        return record
    }

    export const read = (hub: Hub, collection: CollectionDeclaration): ReadonlyArray<ScriptRecordValues> =>
        sortedRecords(hub, collection.name).map(record => {
            const boxes = valueBoxes(record)
            return Object.fromEntries(collection.fields.map(field => {
                const valueBox = boxes.find(candidate => candidate.field.getValue() === field.label)
                return [field.label, isDefined(valueBox) ? valueBox.value.getValue() : field.defaultValue]
            }))
        })

    export const set = (hub: Hub, collection: CollectionDeclaration, index: number, values: ScriptRecordValues): void => {
        const record = sortedRecords(hub, collection.name).at(index)
        if (!isDefined(record) || index < 0) {return}
        const boxes = valueBoxes(record)
        collection.fields.forEach((field, fieldIndex) => {
            const value = values[field.label]
            if (typeof value !== "number" || !Number.isFinite(value)) {return}
            const valueBox = boxes.find(candidate => candidate.field.getValue() === field.label)
            if (isDefined(valueBox)) {
                valueBox.value.setValue(normalize(field, value))
            } else {
                createValue(record, field, fieldIndex, normalize(field, value))
            }
        })
    }

    export const insert = (hub: Hub, collection: CollectionDeclaration, index: number, values: ScriptRecordValues): void => {
        const records = sortedRecords(hub, collection.name)
        const position = Math.max(0, Math.min(records.length, Math.round(index)))
        records.forEach((record, order) => {
            const target = order < position ? order : order + 1
            if (record.order.getValue() !== target) {record.order.setValue(target)}
        })
        create(hub, collection, position, collection.fields.map(field => {
            const value = values[field.label]
            return typeof value === "number" && Number.isFinite(value) ? normalize(field, value) : field.defaultValue
        }))
    }

    export const remove = (hub: Hub, collection: CollectionDeclaration, index: number): void => {
        const records = sortedRecords(hub, collection.name)
        const record = records.at(index)
        if (!isDefined(record) || index < 0) {return}
        record.delete()
        records.filter(other => other !== record).forEach((other, order) => {
            if (other.order.getValue() !== order) {other.order.setValue(order)}
        })
    }

    // Calls `observer` once at the end of every transaction that touched a record or value of the hub.
    export const observe = (hub: Hub, observer: Exec): Terminable => {
        const graph = hub.box.graph
        const state: { dirty: boolean, structural: boolean } = {dirty: false, structural: false}
        const children = new Terminator()
        const markDirty = (): void => {state.dirty = true}
        const markStructural = (): void => {
            state.dirty = true
            state.structural = true
        }
        const subscribeChildren = (): void => {
            children.terminate()
            for (const {box} of hub.pointerHub.filter()) {
                const record = asInstanceOf(box, ScriptRecordBox)
                children.ownAll(
                    graph.subscribeVertexUpdates(Propagation.Children, record.address, markDirty),
                    record.values.pointerHub.subscribe({onAdded: markStructural, onRemoved: markStructural}),
                    ...valueBoxes(record).map(valueBox => graph.subscribeVertexUpdates(Propagation.Children, valueBox.address, markDirty))
                )
            }
        }
        subscribeChildren()
        return Terminable.many(
            hub.pointerHub.subscribe({onAdded: markStructural, onRemoved: markStructural}),
            graph.subscribeTransaction({
                onBeginTransaction: EmptyExec,
                onEndTransaction: () => {
                    if (!state.dirty) {return}
                    state.dirty = false
                    if (state.structural) {
                        state.structural = false
                        subscribeChildren()
                    }
                    observer()
                }
            }),
            children
        )
    }
}
