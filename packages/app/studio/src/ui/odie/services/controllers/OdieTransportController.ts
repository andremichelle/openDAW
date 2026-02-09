import { OdieBaseController } from "./OdieBaseController"
import { OdieTransport } from "../OdieTransport"
import { ToolResult } from "../../OdieTypes"

export class OdieTransportController extends OdieBaseController {
    readonly transport: OdieTransport

    constructor(studio: any) { // Any for now to avoid circular if StudioService imports OdieService
        super(studio)
        this.transport = new OdieTransport(studio)
    }

    async play(): Promise<boolean> {
        try {
            await this.transport.play()
            return true
        } catch (e) {
            console.error("[Odie] Play failed", e)
            return false
        }
    }

    async stop(): Promise<boolean> {
        try {
            await this.transport.stop()
            return true
        } catch (e) {
            console.error("[Odie] Stop failed", e)
            return false
        }
    }

    async record(countIn: boolean = true): Promise<boolean> {
        try {
            this.transport.record(countIn)
            return true
        } catch (e) {
            console.error("[Odie] Record failed", e)
            return false
        }
    }

    async stopRecording(): Promise<boolean> {
        try {
            this.transport.stopRecording()
            return true
        } catch (e) {
            console.error("[Odie] Stop Recording failed", e)
            return false
        }
    }

    async setCountIn(bars: number): Promise<boolean> {
        if (bars < 1) bars = 1
        if (bars > 4) bars = 4
        console.warn("[Odie] CountIn not supported by current Engine Transport Facade.")
        return false
    }

    async setTimelinePosition(bar: number): Promise<boolean> {
        try {
            this.transport.setTimelinePosition(bar)
            return true
        } catch (e) {
            console.error("setTimelinePosition failed", e)
            return false
        }
    }

    async selectTrack(name: string): Promise<boolean> {
        return this.findAudioUnit(name).match({
            some: async (adapter) => {
                this.studio.project.selection.select(adapter)
                return true
            },
            none: () => Promise.resolve(false)
        })
    }

    async setLoop(enabled: boolean): Promise<boolean> {
        this.transport.setLoop(enabled)
        return true
    }

    async setBpm(bpm: number): Promise<ToolResult> {
        if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 20 || bpm > 999) {
            return { success: false, reason: "Invalid BPM. Must be between 20 and 999." }
        }
        const success = this.transport.setBpm(bpm)
        if (!success) {
            return { success: false, reason: "Failed to set BPM (Transport rejected value)." }
        }
        return { success: true, message: `BPM set to ${bpm}` }
    }

    async setTimeSignature(numerator: number, denominator: number): Promise<ToolResult> {
        if (typeof numerator !== 'number' || !Number.isFinite(numerator) || numerator < 1 || numerator > 32) {
            return { success: false, reason: "Invalid time signature numerator." }
        }
        if (typeof denominator !== 'number' || ![1, 2, 4, 8, 16, 32].includes(denominator)) {
            return { success: false, reason: "Invalid time signature denominator (must be power of 2)." }
        }
        const success = this.transport.setTimeSignature(numerator, denominator)
        if (!success) {
            return { success: false, reason: "Failed to set time signature (Transport rejected values)." }
        }
        return { success: true, message: `Time signature set to ${numerator}/${denominator}` }
    }
}
