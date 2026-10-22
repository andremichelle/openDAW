import {ScriptCompiler} from "@opendaw/studio-adapters"

export namespace ScriptCompilers {
    export const Apparat: ScriptCompiler.Config = {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}
    export const Werkstatt: ScriptCompiler.Config = {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}
    export const Spielwerk: ScriptCompiler.Config = {headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"}
}
