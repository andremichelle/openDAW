import {DeviceFactory, EffectPointerType} from "@opendaw/studio-adapters"
import {Field} from "@opendaw/lib-box"
import {int} from "@opendaw/lib-std"
import {Project} from "./project"
import {EffectBox} from "./EffectBox"

export interface EffectFactory extends DeviceFactory {
    readonly separatorBefore: boolean
    readonly type: "audio" | "midi"

    create(project: Project, host: Field<EffectPointerType>, index: int): EffectBox
}