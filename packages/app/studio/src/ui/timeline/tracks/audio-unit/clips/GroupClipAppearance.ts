import {int, isDefined, Observer, Terminable} from "@opendaw/lib-std"
import {MetaData} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"

export namespace GroupClipAppearance {
    export type Settings = {readonly label: string, readonly hue: number}
    const origin = (index: int): string => `opendaw.studio.group-clips.v1.${index}`
    export const read = (group: AudioUnitBox, index: int): Settings => {
        const value = MetaData.read(group, origin(index))
        if (!isDefined(value) || typeof value !== "object" || Array.isArray(value)) {return {label: "", hue: 200}}
        const label = Reflect.get(value, "label")
        const hue = Reflect.get(value, "hue")
        return {
            label: typeof label === "string" ? label.slice(0, 64) : "",
            hue: typeof hue === "number" && Number.isFinite(hue) && hue >= 0 && hue <= 360 ? hue : 200
        }
    }
    export const store = (group: AudioUnitBox, index: int, settings: Settings): void =>
        MetaData.store(group, {label: settings.label, hue: settings.hue}, origin(index))
    export const clear = (group: AudioUnitBox, index: int): void => MetaData.clear(group, origin(index))
    export const subscribe = (group: AudioUnitBox, index: int, observer: Observer<void>): Terminable =>
        MetaData.catchupAndSubscribe(group, origin(index), () => observer())
}
