import {Box} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {isNotUndefined, JSONValue, Nullable, panic, tryCatch, UUID} from "@moises-ai/lib-std"
import {MetaDataBox} from "@moises-ai/studio-boxes"

export namespace MetaData {
    /**
     * Stores the given JSONValue in the target box under the given origin.
     * Needs to be called within a transaction.
     * @param target The box to store the meta-data in.
     * @param value The value to store. Must be JSON-serializable.
     * @param origin The origin of the meta-data. Must be unique to the app.
     */
    export const store = (target: Box<Pointers.MetaData>, value: JSONValue, origin: string): void => {
        if (origin === "") {return panic("MetaData.store: origin must be unique to your app.")}
        const available = target.pointerHub
            .filter(Pointers.MetaData)
            .map(({box}) => box)
            .find((box: Box): box is MetaDataBox => box instanceof MetaDataBox && box.origin.getValue() === origin)
        const apply = (box: MetaDataBox) => {
            box.target.refer(target)
            box.origin.setValue(origin)
            box.value.setValue(JSON.stringify(value))
        }
        if (isNotUndefined(available)) {
            apply(available)
        } else {
            MetaDataBox.create(target.graph, UUID.generate(), apply)
        }
    }

    /**
     * Reads the meta-data from the target box.
     * Returns a failed Attempt if no meta-data is found or the value is not deserializable.
     * @param target The box to read the meta-data from.
     * @param origin The origin of the meta-data. Must be unique to the app.
     */
    export const read = (target: Box<Pointers.MetaData>, origin: string): Nullable<JSONValue> => {
        if (origin === "") {return panic("MetaData.read: origin must be unique to your app.")}
        const existingBox = target.pointerHub
            .filter(Pointers.MetaData)
            .map(({box}) => box)
            .find((box: Box): box is MetaDataBox => box instanceof MetaDataBox && box.origin.getValue() === origin)
        if (isNotUndefined(existingBox)) {
            const {status, value, error} = tryCatch(() => JSON.parse(existingBox.value.getValue()))
            if (status === "success") {return value}
            console.warn(error)
        }
        return null
    }

    /**
     * Deletes all meta-data from the target box with the given origin.
     * Needs to be called within a transaction.
     * @param target The box to delete the meta-data from.
     * @param origin The origin of the meta-data. Must be unique to the app.
     */
    export const clear = (target: Box<Pointers.MetaData>, origin: string): void => {
        if (origin === "") {return panic("MetaData.clear: origin must be unique to your app.")}
        target.pointerHub
            .filter(Pointers.MetaData)
            .map(({box}) => box)
            .filter((box: Box): box is MetaDataBox => box instanceof MetaDataBox && box.origin.getValue() === origin)
            .forEach(box => box.delete())
    }
}