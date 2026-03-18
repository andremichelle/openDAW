import {createScriptCompiler} from "@/ui/werkstatt-editor/ScriptCompiler"

export const WerkstattCompiler = createScriptCompiler({
    headerTag: "werkstatt",
    registryName: "werkstattProcessors",
    functionName: "werkstatt"
})
