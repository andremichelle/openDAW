import {RuntimeNotifier} from "@opendaw/lib-std"
import {Result, Validator} from "./validator"

export const NameValidator: Validator<string> = {
    validate: (value: string, match: Result<string>, origin?: Element): void => {
        const trimmed = value.trim()
        if (trimmed.length <= 64) {
            match.success(trimmed)
        } else {
            match.failure?.call(null)
            RuntimeNotifier.notify({message: "A name must not exceed 64 characters.", icon: "Info", origin})
        }
    }
}