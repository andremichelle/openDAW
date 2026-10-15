import {Option} from "@opendaw/lib-std"
import {Platform} from "@opendaw/lib-dom"

export const AccessKey = {
    get: (): Option<string> => Option.wrap(Platform.storage().getItem("access-key"))
}
