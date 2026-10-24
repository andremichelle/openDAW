import {IconSymbol} from "@opendaw/studio-enums"
import {AudioBusBox} from "@opendaw/studio-boxes"
import {int} from "@opendaw/lib-std"

export type InstrumentOptions<T = never> = { name?: string, icon?: IconSymbol, index?: int, attachment?: T, destination?: AudioBusBox }