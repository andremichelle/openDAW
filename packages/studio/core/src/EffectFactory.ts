import {DeviceFactory, EffectPointerType} from "@moises-ai/studio-adapters"
import {Field} from "@moises-ai/lib-box"
import {int} from "@moises-ai/lib-std"
import {Project} from "./project"
import {EffectBox} from "./EffectBox"

export interface EffectFactory extends DeviceFactory {
    readonly separatorBefore: boolean
    readonly type: "audio" | "midi"

    create(project: Project, host: Field<EffectPointerType>, index: int): EffectBox
}