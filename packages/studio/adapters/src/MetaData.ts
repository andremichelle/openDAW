import {Box, PointerField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {
    isNotUndefined,
    JSONValue,
    Nullable,
    Observer,
    Option,
    panic,
    Subscription,
    Terminable,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {MetaDataBox} from "@opendaw/studio-boxes"

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

    /**
     * Subscribes to meta-data changes on the target box for the given origin.
     * Catches up with existing meta-data and subscribes to future additions/removals.
     * The observer receives the parsed JSONValue or null when cleared.
     * @param target The box to observe meta-data on.
     * @param origin The origin of the meta-data. Must be unique to the app.
     * @param observer Called with the current value whenever it changes, or null when removed.
     */
    export const catchupAndSubscribeMessage = (target: Box<Pointers.MetaData>,
                                               origin: string,
                                               observer: Observer<Option<JSONValue>>): Terminable => {
        if (origin === "") {return panic("MetaData.catchupAndSubscribeMessage: origin must be unique to your app.")}
        const subscriptions = UUID.newSet<{ uuid: UUID.Bytes, subscription: Subscription }>(entry => entry.uuid)
        const notifyValue = (metaDataBox: MetaDataBox): void => {
            const {status, value, error} = tryCatch(() => JSON.parse(metaDataBox.value.getValue()))
            if (status === "success") {
                observer(Option.wrap(value))
            } else {
                console.warn(error)
                observer(Option.None)
            }
        }
        const pointerHubSubscription = target.pointerHub.catchupAndSubscribe({
            onAdded: ({box}: PointerField) => {
                if (!(box instanceof MetaDataBox) || box.origin.getValue() !== origin) {return}
                const subscription = box.value.catchupAndSubscribe(() => notifyValue(box))
                subscriptions.add({uuid: box.address.uuid, subscription})
            },
            onRemoved: ({box}: PointerField) => {
                if (!(box instanceof MetaDataBox) || box.origin.getValue() !== origin) {return}
                const entry = subscriptions.removeByKey(box.address.uuid)
                entry.subscription.terminate()
                observer(Option.None)
            }
        }, Pointers.MetaData)
        return {
            terminate: () => {
                pointerHubSubscription.terminate()
                subscriptions.forEach(({subscription}) => subscription.terminate())
                subscriptions.clear()
            }
        }
    }
}