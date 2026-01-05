import {DelayEffect} from "../Api"

export class DelayEffectImpl implements DelayEffect {
    readonly key = "delay" as const

    label: string
    enabled: boolean

    // Pre-delay Left
    preSyncTimeLeft: number
    preMillisTimeLeft: number

    // Pre-delay Right
    preSyncTimeRight: number
    preMillisTimeRight: number

    // Main Delay
    delay: number
    millisTime: number
    feedback: number
    cross: number
    lfoSpeed: number
    lfoDepth: number
    filter: number

    // Mix
    dry: number
    wet: number

    constructor(props?: Partial<DelayEffect>) {
        this.label = props?.label ?? "Delay"
        this.enabled = props?.enabled ?? true

        // Pre-delay Left
        this.preSyncTimeLeft = props?.preSyncTimeLeft ?? 0
        this.preMillisTimeLeft = props?.preMillisTimeLeft ?? 0

        // Pre-delay Right
        this.preSyncTimeRight = props?.preSyncTimeRight ?? 0
        this.preMillisTimeRight = props?.preMillisTimeRight ?? 0

        // Main Delay
        this.delay = props?.delay ?? 4
        this.millisTime = props?.millisTime ?? 0
        this.feedback = props?.feedback ?? 0.5
        this.cross = props?.cross ?? 0
        this.lfoSpeed = props?.lfoSpeed ?? 0
        this.lfoDepth = props?.lfoDepth ?? 0
        this.filter = props?.filter ?? 0

        // Mix
        this.dry = props?.dry ?? 0.0
        this.wet = props?.wet ?? -6.0
    }
}
