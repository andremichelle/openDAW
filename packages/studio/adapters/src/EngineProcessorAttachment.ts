import {int, isDefined, Option} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"

export type ProcessorOptions = {}

// This is the type for passing over information to the main audio-worklet
export type EngineProcessorAttachment = {
    syncStreamBuffer: SharedArrayBuffer // SyncStream SharedArrayBuffer
    controlFlagsBuffer: SharedArrayBuffer // Control flags SharedArrayBuffer (e.g., for sleep)
    hrClockBuffer: SharedArrayBuffer // High-res clock SharedArrayBuffer
    project: ArrayBufferLike
    exportConfiguration?: ExportConfiguration
    options?: ProcessorOptions
    variant?: Record<string, unknown> // structured-clonable extras for an alternative engine processor (EngineVariant)
}

export type ExportStemConfiguration = {
    includeAudioEffects: boolean
    includeSends: boolean
    useInstrumentOutput: boolean
    skipChannelStrip?: boolean
    fileName: string
}

export type ExportRange = "full" | { start: ppqn, end: ppqn }

export type ExportConfiguration = {
    stems?: Record<string, ExportStemConfiguration>
    range?: ExportRange
}

export namespace ExportConfiguration {
    export const countStems = (config: Option<ExportConfiguration>): int =>
        config.match({
            none: () => 1,
            some: cfg => isDefined(cfg.stems) ? Object.keys(cfg.stems).length : 1
        })

    export const sanitizeFileName = (name: string): string => name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim()

    export const sanitizeExportNamesInPlace = (configuration: ExportConfiguration): void => {
        if (!isDefined(configuration.stems)) {return}
        const stems = configuration.stems
        const sanitizedNames = new Map<string, number>()
        const getUniqueName = (baseName: string): string => {
            let count = sanitizedNames.get(baseName) ?? 0
            let newName = baseName
            while (sanitizedNames.has(newName)) {
                count++
                newName = `${baseName} ${count}`
            }
            sanitizedNames.set(baseName, count)
            sanitizedNames.set(newName, 1)
            return newName
        }
        Object.keys(stems).forEach((key) => {
            const entry = stems[key]
            entry.fileName = getUniqueName(sanitizeFileName(entry.fileName))
        })
    }
}
