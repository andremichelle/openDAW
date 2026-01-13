import {IconSymbol} from "@moises-ai/studio-enums"

export interface DeviceFactory {
    readonly defaultName: string
    readonly defaultIcon: IconSymbol
    readonly description: string
    readonly manualPage: string
}