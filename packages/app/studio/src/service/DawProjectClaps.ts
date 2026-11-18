import {Errors, isDefined, Option} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {WclapCatalog} from "@/opendaw-api"
import {SpotlightCreate} from "@/ui/spotlight/SpotlightCreate"

// a CLAP plugin of an imported DAWproject plays as the WebCLAP holding the same plugin id
export namespace DawProjectClaps {
    export const resolve = async (pluginId: string): Promise<Option<string>> => {
        const entries = await Promises.tryCatch(WclapCatalog.get().all())
        if (entries.status === "rejected") {return Option.None}
        const entry = entries.value.find(({plugins}) => plugins.some(plugin => plugin.clapId === pluginId))
        if (!isDefined(entry)) {return Option.None}
        const stored = await Promises.tryCatch(SpotlightCreate.storeWclap({id: entry.uuid, name: entry.name}))
        if (stored.status === "rejected") {
            if (!Errors.isAbort(stored.error)) {console.warn(stored.error)}
            return Option.None
        }
        return Option.wrap(stored.value)
    }
}
