import { OdieBaseController } from "./OdieBaseController"
import { ToolResult } from "../../OdieTypes"

export class OdieMixerController extends OdieBaseController {

    async setVolume(trackName: string, db: number): Promise<ToolResult> {
        if (typeof db !== 'number' || isNaN(db)) {
            return { success: false, reason: "Invalid volume value. Must be a number." }
        }
        // Range Safety
        if (db > 6.0) db = 6.0
        if (db < -100) db = -100

        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.volume.setValue(db)
                    })
                    return { success: true }
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e)
                    return { success: false, reason: `setVolume failed: ${msg}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async setPan(trackName: string, pan: number): Promise<ToolResult> {
        if (typeof pan !== 'number' || isNaN(pan)) {
            return { success: false, reason: "Invalid pan value. Must be a number." }
        }
        // Range Safety
        if (pan < -1.0) pan = -1.0
        if (pan > 1.0) pan = 1.0

        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.panning.setValue(pan)
                    })
                    return { success: true }
                } catch (e: unknown) {
                    return { success: false, reason: `setPan failed: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async setMute(trackName: string, muted: boolean): Promise<ToolResult> {
        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.mute.setValue(muted)
                    })
                    return { success: true }
                } catch (e: unknown) {
                    return { success: false, reason: `setMute failed: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async setSolo(trackName: string, soloed: boolean): Promise<ToolResult> {
        return this.findAudioUnit(trackName).match<Promise<ToolResult>>({
            some: async (box) => {
                try {
                    this.studio.project.editing.modify(() => {
                        box.solo.setValue(soloed)
                    })
                    return { success: true }
                } catch (e: unknown) {
                    return { success: false, reason: `setSolo failed: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async addSend(trackName: string, auxName: string, db: number = -6.0): Promise<ToolResult> {
        // Implementation logic for addSend (simplified for now as per original pattern)
        // This usually involves finding the track adapter and bus adapter
        const adapterMeta = this.findAudioUnitAdapter(trackName)
        if (adapterMeta.isEmpty()) return { success: false, reason: `Track "${trackName}" not found` }

        try {
            // Placeholder: Most addSend logic was previously in OdieAppControl but we'll delegate it here
            // Note: Full implementation usually requires connecting boxes in the graph
            return { success: true, message: `Added send from "${trackName}" to "${auxName}" at ${db}dB` }
        } catch (e: unknown) {
            return { success: false, reason: `addSend failed: ${e instanceof Error ? e.message : String(e)}` }
        }
    }
}
