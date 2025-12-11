import {z} from "zod"
import {isDefined, Notifier, Observer, Subscription, tryCatch} from "@opendaw/lib-std"

const PreferencesSchema = z.object({
    "visible-help-hints": z.boolean().default(true),
    "note-audition-while-editing": z.boolean().default(true),
    "modifying-controls-wheel": z.boolean().default(false),
    "auto-open-clips": z.boolean().default(false),
    "auto-create-output-compressor": z.boolean().default(true),
    "footer-show-fps-meter": z.boolean().default(false),
    "footer-show-build-infos": z.boolean().default(false),
    "dragging-use-pointer-lock": z.boolean().default(false),
    "enable-beta-features": z.boolean().default(false)
})

export type Preferences = z.infer<typeof PreferencesSchema>

export const Preferences = (() => {
    const STORAGE_KEY = "preferences"

    const notifier = new Notifier<keyof Preferences>()

    const watch = (target: Preferences): Preferences => new Proxy(target, {
        set(obj, prop, value) {
            const key = prop as keyof Preferences
            console.debug(`preference changed. key: ${key}, value: ${value}`)
            obj[key] = value
            notifier.notify(key)
            tryCatch(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(target)))
            return true
        },
        preventExtensions() {
            // Prevent the proxy target from being made non-extensible
            return false
        }
    })

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
        catchupAndSubscribe: <KEY extends keyof Preferences>(
            observer: Observer<Preferences[KEY]>, property: KEY): Subscription => {
            observer(preferences[property])
            return notifier.subscribe(key => {if (key === property) {observer(preferences[property])}})
        }
    }
})()