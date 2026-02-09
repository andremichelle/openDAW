import { Option } from "@opendaw/lib-std"
import { AudioUnitBoxAdapter, AudioBusBoxAdapter } from "@opendaw/studio-adapters"
import { AudioUnitBox } from "@opendaw/studio-boxes"
import { StudioService } from "../../../../service/StudioService"

export abstract class OdieBaseController {
    constructor(protected studio: StudioService) { }

    public findAudioUnitAdapter(name: string): Option<AudioUnitBoxAdapter> {
        if (!this.studio.hasProfile) return Option.None
        const root = this.studio.project.rootBoxAdapter
        const allAdapters = [
            ...root.audioUnits.adapters(),
            ...root.audioBusses.adapters()
        ]
        const targetName = name.trim()
        const match = allAdapters.find(a => {
            let label = ""
            if (a instanceof AudioUnitBoxAdapter) {
                label = a.label
            } else if (a instanceof AudioBusBoxAdapter) {
                label = a.labelField.getValue()
            }
            const labelTrim = label.trim()
            return a.box.isAttached() && (labelTrim === targetName || labelTrim.toLowerCase() === targetName.toLowerCase())
        })

        if (!match) {
            if (name !== "") {
                const labels = allAdapters.map(a => {
                    if (a instanceof AudioUnitBoxAdapter) return `[Unit] ${a.label}`
                    if (a instanceof AudioBusBoxAdapter) return `[Bus/Device] ${a.labelField.getValue()}`
                    return `[Unknown] ${(a as { address?: { toString(): string } }).address?.toString() ?? "no address"}`
                })
                console.warn(`[Odie] findAudioUnitAdapter: No match for "${name}". Available:`, labels)
            }
            return Option.None
        }

        if ('audioUnitBoxAdapter' in match && typeof match.audioUnitBoxAdapter === 'function') {
            return Option.wrap((match as any).audioUnitBoxAdapter())
        }
        return Option.wrap(match as AudioUnitBoxAdapter)
    }

    protected findAudioUnit(name: string): Option<AudioUnitBox> {
        return this.findAudioUnitAdapter(name).map(a => a.box)
    }
}
