import {Option} from "@opendaw/lib-std"

export const AccessKey = {
    get: (): Option<string> => Option.wrap(localStorage.getItem("access-key"))
}
