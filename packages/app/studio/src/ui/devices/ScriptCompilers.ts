import {InstrumentFactories, ScriptCompiler} from "@opendaw/studio-adapters"
import {EffectFactories} from "@opendaw/studio-core"

export namespace ScriptCompilers {
    export const Apparat: ScriptCompiler.Config = {
        headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat",
        defaultName: InstrumentFactories.Apparat.defaultName
    }
    export const Werkstatt: ScriptCompiler.Config = {
        headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt",
        defaultName: EffectFactories.Werkstatt.defaultName
    }
    export const Spielwerk: ScriptCompiler.Config = {
        headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk",
        defaultName: EffectFactories.Spielwerk.defaultName
    }
}
