import {Option, Terminable} from "@opendaw/lib-std"

export type MonitoringMode = "off" | "direct" | "effects"

export interface MonitorPort extends Terminable {
    get mode(): MonitoringMode
    set mode(value: MonitoringMode)
    get volumeDb(): number
    set volumeDb(value: number)
    get pan(): number
    set pan(value: number)
    get muted(): boolean
    set muted(value: boolean)
    get outputDeviceId(): Option<string>
    setOutputDevice(deviceId: Option<string>): Promise<void>
}
