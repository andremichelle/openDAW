import {z} from "zod"
import {isDefined, Notifier, Observer, Subscription, tryCatch} from "@opendaw/lib-std"

// Recursive path as tuple for nested property access
type PathTuple<T> = T extends object
    ? { [K in keyof T]: [K] | [K, ...PathTuple<T[K]>] }[keyof T]
    : []

// Get value type at path
type ValueAtPath<T, P extends readonly unknown[]> = P extends readonly [infer K, ...infer Rest]
    ? K extends keyof T
        ? Rest extends [] ? T[K] : ValueAtPath<T[K], Rest>
        : never
    : T

const PreferencesSchema = z.object({
    "visible-help-hints": z.boolean().default(true),
    "enable-history-buttons": z.boolean().default(false),
    "note-audition-while-editing": z.boolean().default(true),
    "modifying-controls-wheel": z.boolean().default(false),
    "auto-open-clips": z.boolean().default(true),
    "auto-create-output-compressor": z.boolean().default(true),
    "footer-show-fps-meter": z.boolean().default(false),
    "footer-show-build-infos": z.boolean().default(false),
    "normalize-mouse-wheel": z.boolean().default(false),
    "time-display": z.object({
        "musical": z.boolean(),
        "absolute": z.boolean(),
        "details": z.boolean()
    }).default({musical: true, absolute: false, details: false}),
    "dragging-use-pointer-lock": z.boolean().default(false),
    "enable-beta-features": z.boolean().default(false)
})

export type Preferences = z.infer<typeof PreferencesSchema>

export const Preferences = (() => {
    const STORAGE_KEY = "preferences"

    const notifier = new Notifier<keyof Preferences>()

    const watch = (target: Preferences): Preferences => {
        const createProxy = <T extends object>(obj: T, rootKey?: keyof Preferences): T => new Proxy(obj, {
            get(target, prop) {
                const value = target[prop as keyof T]
                if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                    return createProxy(value as object, rootKey ?? prop as keyof Preferences) as T[keyof T]
                }
                return value
            },
            set(obj, prop, value) {
                const key = rootKey ?? prop as keyof Preferences
                console.debug(`preference changed. key: ${key}, value: ${value}`)
                ;(obj as any)[prop] = value
                notifier.notify(key)
                tryCatch(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(target)))
                return true
            },
            preventExtensions() {
                return false
            }
        })
        return createProxy(target)
    }

    const getOrCreate = (): Preferences => {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (isDefined(stored)) {
            const {status, value} = tryCatch(() => JSON.parse(stored))
            if (status === "success") {
                return watch({...PreferencesSchema.parse(value)})
            }
        }
        return watch({...PreferencesSchema.parse({})})
    }

    const preferences = getOrCreate()
    return {
        values: preferences,
        catchupAndSubscribe: <P extends PathTuple<Preferences>>(
            observer: Observer<ValueAtPath<Preferences, P>>, ...path: P): Subscription => {
            const getValue = (): ValueAtPath<Preferences, P> =>
                path.reduce((obj: any, key) => obj[key], preferences)
            observer(getValue())
            return notifier.subscribe(key => {
                if (key === path[0]) {observer(getValue())}
            })
        }
    }
})()