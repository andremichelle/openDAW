import {IconSymbol} from "@moises-ai/studio-enums"
import {int} from "@moises-ai/lib-std"

export type InstrumentOptions<T = never> = { name?: string, icon?: IconSymbol, index?: int, attachment?: T }