import { UUID } from "@opendaw/lib-std"
import { TimeBase } from "@opendaw/lib-dsp"
import {
    AudioFileBox,
    ValueEventCollectionBox,
    AudioRegionBox
} from "@opendaw/studio-boxes"
import { OdieBaseController } from "./OdieBaseController"
import { ToolResult } from "../../OdieTypes"

export class OdieExportController extends OdieBaseController {
    public async exportMixdown(): Promise<boolean> {
        try {
            await this.studio.exportMixdown()
            return true
        } catch (e) {
            console.error("Export Mixdown failed", e)
            return false
        }
    }

    public async exportStems(): Promise<boolean> {
        try {
            await this.studio.exportStems()
            return true
        } catch (e) {
            console.error("Export Stems failed", e)
            return false
        }
    }

    public async importAudio(trackName: string, durationSeconds: number = 2.0): Promise<ToolResult> {
        try {
            const sampleRate = this.studio.sampleRate
            const wavBuffer = this.createSineWaveWav(durationSeconds, 440, sampleRate)

            const sample = await this.studio.sampleService.importFile({
                name: `${trackName}_Source`,
                arrayBuffer: wavBuffer
            })
            const sampleUuid = UUID.parse(sample.uuid)

            // Note: This relies on addTrack which is in ProjectController.
            // In the final Facade (OdieAppControl), these will be interconnected.
            // For now, we assume the track exists or we use the facade's delegation.
            const adapterMeta = this.findAudioUnitAdapter(trackName)
            if (adapterMeta.isEmpty()) return { success: false, reason: `Track "${trackName}" not found` }
            const adapter = adapterMeta.unwrap()

            const track = adapter.tracks.values()[0]
            if (!track) return { success: false, reason: "No track lane found" }

            const { editing, boxGraph } = this.studio.project

            editing.modify(() => {
                const audioFileBox = AudioFileBox.create(boxGraph, sampleUuid, box => {
                    box.fileName.setValue(sample.name)
                    box.startInSeconds.setValue(0)
                    box.endInSeconds.setValue(durationSeconds)
                })

                const valueEventCollectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())

                AudioRegionBox.create(boxGraph, UUID.generate(), regionBox => {
                    regionBox.file.refer(audioFileBox)
                    regionBox.duration.setValue(durationSeconds)
                    regionBox.loopDuration.setValue(durationSeconds)
                    regionBox.position.setValue(0)
                    regionBox.timeBase.setValue(TimeBase.Seconds)
                    regionBox.events.refer(valueEventCollectionBox.owners)
                    regionBox.regions.refer(track.box.regions)
                })
            })

            return { success: true, message: `Imported audio to track '${trackName}'` }
        } catch (e: unknown) {
            return { success: false, reason: `importAudio failed: ${e instanceof Error ? e.message : String(e)}` }
        }
    }

    private createSineWaveWav(duration: number, frequency: number, sampleRate: number): ArrayBuffer {
        const numChannels = 1
        const bitsPerSample = 16
        const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
        const blockAlign = (numChannels * bitsPerSample) / 8
        const dataSize = duration * byteRate
        const buffer = new ArrayBuffer(44 + dataSize)
        const view = new DataView(buffer)

        this.writeString(view, 0, 'RIFF')
        view.setUint32(4, 36 + dataSize, true)
        this.writeString(view, 8, 'WAVE')
        this.writeString(view, 12, 'fmt ')
        view.setUint32(16, 16, true)
        view.setUint16(20, 1, true)
        view.setUint16(22, numChannels, true)
        view.setUint32(24, sampleRate, true)
        view.setUint32(28, byteRate, true)
        view.setUint16(32, blockAlign, true)
        view.setUint16(34, bitsPerSample, true)
        this.writeString(view, 36, 'data')
        view.setUint32(40, dataSize, true)

        const PI2 = Math.PI * 2
        const angleStep = (PI2 * frequency) / sampleRate
        let angle = 0
        for (let i = 0; i < dataSize / 2; i++) {
            const sample = Math.sin(angle) * 32767
            view.setInt16(44 + i * 2, sample, true)
            angle += angleStep
        }

        return buffer
    }

    private writeString(view: DataView, offset: number, string: string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i))
        }
    }
}
