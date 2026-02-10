import {int, Option} from "@opendaw/lib-std"

export type ProcessorOptions = {}

// This is the type for passing over information to the main audio-worklet
export type EngineProcessorAttachment = {
    syncStreamBuffer: SharedArrayBuffer // SyncStream SharedArrayBuffer
    controlFlagsBuffer: SharedArrayBuffer // Control flags SharedArrayBuffer (e.g., for sleep)
    hrClockBuffer: SharedArrayBuffer // High-res clock SharedArrayBuffer
    project: ArrayBufferLike
    exportConfiguration?: ExportStemsConfiguration
    options?: ProcessorOptions
}

export type ExportStemConfiguration = {
    includeAudioEffects: boolean
    includeSends: boolean
    useInstrumentOutput: boolean
    fileName: string
}

export type ExportStemsConfiguration = Record<string, ExportStemConfiguration>

export namespace ExportStemsConfiguration {
    export const countStems = (config: Option<ExportStemsConfiguration>): int =>
        config.match({
            none: () => 1,
            some: (configuration) => Object.keys(configuration).length
        })

    export const sanitizeFileName = (name: string): string => name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim()

    export const sanitizeExportNamesInPlace = (configuration: ExportStemsConfiguration): void => {
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
        Object.keys(configuration).forEach((key) => {
            const entry = configuration[key]
            entry.fileName = getUniqueName(sanitizeFileName(entry.fileName))
        })
    }
}