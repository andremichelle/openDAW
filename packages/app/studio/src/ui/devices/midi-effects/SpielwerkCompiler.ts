import {createScriptCompiler} from "@/ui/werkstatt-editor/ScriptCompiler"

export const SpielwerkCompiler = createScriptCompiler({
    headerTag: "spielwerk",
    registryName: "spielwerkProcessors",
    functionName: "spielwerk"
})
