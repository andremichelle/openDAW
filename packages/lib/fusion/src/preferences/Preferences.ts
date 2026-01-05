import {
    isDefined,
    MutableObservableValue,
    Observer,
    PathTuple,
    Subscription,
    Terminable,
    tryCatch,
    ValueAtPath
} from "@opendaw/lib-std"
import {PreferencesFacade} from "./PreferencesFacade"
import {PreferencesHost} from "./PreferencesHost"
import {z} from "zod"

export interface Preferences<SETTINGS> {
    get settings(): SETTINGS
    subscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription
    catchupAndSubscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription
    createMutableObservableValue<P extends PathTuple<SETTINGS>>(...path: P)
        : MutableObservableValue<ValueAtPath<SETTINGS, P>> & Terminable
}

export namespace Preferences {
    export const host = <SETTINGS extends object>(key: string, zod: z.ZodType<SETTINGS>): PreferencesHost<SETTINGS> => {
        const facade = new PreferencesHost<SETTINGS>(loadFromStorage(key, zod))
        facade.subscribeAll(() => tryCatch(() => localStorage.setItem(key, JSON.stringify(facade.settings))))
        return facade
    }

    export const facade = <SETTINGS extends object>(key: string, zod: z.ZodType<SETTINGS>): PreferencesFacade<SETTINGS> => {
        const facade = new PreferencesFacade<SETTINGS>(loadFromStorage(key, zod))
        facade.subscribeAll(() => tryCatch(() => localStorage.setItem(key, JSON.stringify(facade.settings))))
        return facade
    }

    const loadFromStorage = <SETTINGS>(key: string, zod: z.ZodType<SETTINGS>): SETTINGS => {
        const stored = localStorage.getItem(key)
        if (isDefined(stored)) {
            const {status, value} = tryCatch(() => JSON.parse(stored))
            if (status === "success") {
                return zod.parse(value)
            }
        }
        return zod.parse({})
    }
}