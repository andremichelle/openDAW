import {
    isDefined,
    MutableObservableValue,
    Observer,
    PathTuple,
    Subscription,
    Terminable,
    tryCatch,
    ValueAtPath
} from "@moises-ai/lib-std"
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
    const hasLocalStorage = typeof localStorage !== "undefined"

    export const host = <SETTINGS extends object>(key: string, zod: z.ZodType<SETTINGS>): PreferencesHost<SETTINGS> => {
        const facade = new PreferencesHost<SETTINGS>(loadFromStorage(key, zod))
        if (hasLocalStorage) {
            facade.subscribeAll(() => tryCatch(() => localStorage.setItem(key, JSON.stringify(facade.settings))))
        }
        return facade
    }

    export const facade = <SETTINGS extends object>(key: string, zod: z.ZodType<SETTINGS>): PreferencesFacade<SETTINGS> => {
        const facade = new PreferencesFacade<SETTINGS>(loadFromStorage(key, zod))
        if (hasLocalStorage) {
            facade.subscribeAll(() => tryCatch(() => localStorage.setItem(key, JSON.stringify(facade.settings))))
        }
        return facade
    }

    const loadFromStorage = <SETTINGS>(key: string, zod: z.ZodType<SETTINGS>): SETTINGS => {
        const defaults = zod.parse({})
        if (!hasLocalStorage) {return defaults}
        const stored = localStorage.getItem(key)
        if (!isDefined(stored)) {return defaults}
        const {status, value} = tryCatch(() => JSON.parse(stored))
        if (status !== "success" || typeof value !== "object" || value === null) {return defaults}
        const result = zod.safeParse(value)
        if (result.success) {return result.data}
        // Full parse failed (schema changed). Parse each section independently to preserve valid user settings.
        const merged: Record<string, unknown> = {}
        for (const sectionKey of Object.keys(defaults as Record<string, unknown>)) {
            const sectionSchema = (zod as z.ZodObject<any>).shape?.[sectionKey]
            if (isDefined(sectionSchema) && isDefined((value as Record<string, unknown>)[sectionKey])) {
                const sectionResult = sectionSchema.safeParse((value as Record<string, unknown>)[sectionKey])
                merged[sectionKey] = sectionResult.success
                    ? sectionResult.data
                    : (defaults as Record<string, unknown>)[sectionKey]
            } else {
                merged[sectionKey] = (defaults as Record<string, unknown>)[sectionKey]
            }
        }
        return merged as SETTINGS
    }
}