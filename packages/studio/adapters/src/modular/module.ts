import {Box, Vertex} from "@moises-ai/lib-box"
import {
    BoxVisitor,
    ModularAudioInputBox,
    ModularAudioOutputBox,
    ModuleAttributes,
    ModuleDelayBox,
    ModuleGainBox,
    ModuleMultiplierBox
} from "@moises-ai/studio-boxes"
import {asDefined, Selectable} from "@moises-ai/lib-std"
import {Pointers} from "@moises-ai/studio-enums"
import {ModuleDelayAdapter} from "./modules/delay"
import {ModularAudioOutputAdapter} from "./modules/audio-output"
import {ModuleGainAdapter} from "./modules/gain"
import {BoxAdapter} from "../BoxAdapter"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {ModularAdapter} from "./modular"
import {Direction, ModuleConnectorAdapter} from "./connector"
import {BoxAdapters} from "../BoxAdapters"
import {ModuleMultiplierAdapter} from "./modules/multiplier"
import {ModularAudioInputAdapter} from "./modules/audio-input"

export interface ModuleAdapter extends BoxAdapter, Selectable {
    get attributes(): ModuleAttributes
    get parameters(): ParameterAdapterSet
    get modular(): ModularAdapter
    get inputs(): ReadonlyArray<ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Input>>
    get outputs(): ReadonlyArray<ModuleConnectorAdapter<Pointers.VoltageConnection, Direction.Output>>
}

export namespace Modules {
    export const isVertexOfModule = (vertex: Vertex): boolean => vertex.box.accept<BoxVisitor<true>>({
        visitModuleGainBox: (): true => true,
        visitModuleDelayBox: (): true => true,
        visitModuleMultiplierBox: (): true => true,
        visitModularAudioInputBox: (): true => true,
        visitModularAudioOutputBox: (): true => true
    }) ?? false

    export const adapterFor = (adapters: BoxAdapters, box: Box): ModuleAdapter => asDefined(box.accept<BoxVisitor<ModuleAdapter>>({
        visitModuleGainBox: (box: ModuleGainBox): ModuleAdapter => adapters.adapterFor(box, ModuleGainAdapter),
        visitModuleDelayBox: (box: ModuleDelayBox): ModuleAdapter => adapters.adapterFor(box, ModuleDelayAdapter),
        visitModuleMultiplierBox: (box: ModuleMultiplierBox): ModuleAdapter => adapters.adapterFor(box, ModuleMultiplierAdapter),
        visitModularAudioInputBox: (box: ModularAudioInputBox): ModuleAdapter => adapters.adapterFor(box, ModularAudioInputAdapter),
        visitModularAudioOutputBox: (box: ModularAudioOutputBox): ModuleAdapter => adapters.adapterFor(box, ModularAudioOutputAdapter)
    }), `Could not find ModuleAdapter for ${box.name}`)
}
