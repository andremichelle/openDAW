import {int, isDefined, Option} from "@opendaw/lib-std"
import {AudioData, ppqn} from "@opendaw/lib-dsp"
import {EngineSettings} from "./engine/EnginePreferencesSchema"

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

// The metronome in an OFFLINE render. Absent means silent, so a mixdown can never pick up a click by accident;
// only an explicit `includeInMixdown` / `stem` turns it on. The live engine takes these from the
// "engine-preferences" channel, but an offline render is a one-shot with nothing to live-update, so they are
// settled once, here, and travel with the rest of the export configuration.
export type ExportMetronomeConfiguration = {
    // Mix the click into the stereo mixdown. Only meaningful for a render WITHOUT stems.
    includeInMixdown?: boolean
    // Emit the click as an ADDITIONAL stem, appended AFTER the unit stems. Only meaningful WITH stems.
    stem?: { fileName: string }
    // Overrides for the engine's metronome defaults; omitted keys keep EngineSettingsSchema's defaults
    // (gain -6dB, beatSubDivision 1, monophonic true). `enabled` is deliberately not settable here:
    // includeInMixdown/stem already decide it, so there is exactly one answer per render.
    settings?: Partial<Omit<EngineSettings["metronome"], "enabled">>
    // Custom click PCM replacing the engine's synthesized defaults (880Hz downbeat / 440Hz beat). Index 0 is
    // the downbeat and 1 every other beat, the same convention as EngineCommands.loadClickSound, which is how
    // the LIVE engine receives them. Carried in the config rather than sent as a command because the offline
    // render loop never yields: a command racing `render()` would only be dequeued once the render had already
    // finished, silently falling back to the defaults. `initialize()` is awaited, so this cannot lose that
    // race. AudioData.frames are SharedArrayBuffer-backed, so this is shared, not copied.
    clickSounds?: { downbeat?: AudioData, beat?: AudioData }
}

export type ExportConfiguration = {
    stems?: Record<string, ExportStemConfiguration>
    metronome?: ExportMetronomeConfiguration
    range?: ExportRange
}

export namespace ExportConfiguration {
    // The number of STEREO PAIRS a render writes, which sizes `numberOfChannels` (pairs * 2). Without stems a
    // render is a single mixdown pair and the metronome (if any) mixes INTO it rather than adding a pair.
    export const countStems = (config: Option<ExportConfiguration>): int =>
        config.match({
            none: () => 1,
            some: cfg => isDefined(cfg.stems)
                ? Object.keys(cfg.stems).length + (isDefined(cfg.metronome?.stem) ? 1 : 0)
                : 1
        })

    // Whether the engine must render the metronome at all for this configuration.
    export const isMetronomeAudible = (config: Option<ExportConfiguration>): boolean =>
        config.match({
            none: () => false,
            some: cfg => isDefined(cfg.stems)
                ? isDefined(cfg.metronome?.stem)
                : cfg.metronome?.includeInMixdown === true
        })

    // The stem file names in CHANNEL ORDER: the unit stems in `stems` key order, then the metronome pair LAST.
    // That is exactly the order the engine stages them in (`set_stem_export` writes the unit records, then
    // `copy_stem_outputs` appends the metronome), and a writer maps channel pair i to name i. Derive the names
    // from HERE rather than re-walking `stems`, which yields one name too few and writes `undefined.wav`.
    export const stemFileNames = (config: ExportConfiguration): ReadonlyArray<string> => {
        const names = Object.values(config.stems ?? {}).map(({fileName}) => fileName)
        const metronomeStem = config.metronome?.stem
        if (isDefined(metronomeStem)) {names.push(metronomeStem.fileName)}
        return names
    }

    export const sanitizeFileName = (name: string): string => name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim()

    export const sanitizeExportNamesInPlace = (configuration: ExportConfiguration): void => {
        const metronomeStem = configuration.metronome?.stem
        if (!isDefined(configuration.stems) && !isDefined(metronomeStem)) {return}
        const stems = configuration.stems ?? {}
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
        // The metronome shares the unit stems' namespace (they all land in one zip, where a duplicate name
        // silently overwrites) and is sanitized LAST, matching its channel order, so a collision renames the
        // click rather than a project stem.
        if (isDefined(metronomeStem)) {
            metronomeStem.fileName = getUniqueName(sanitizeFileName(metronomeStem.fileName))
        }
    }
}
