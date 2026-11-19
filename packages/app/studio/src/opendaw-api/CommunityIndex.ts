import {z} from "zod"
import {Option, UUID} from "@opendaw/lib-std"
import type {InstrumentFactories} from "@opendaw/studio-adapters"
import type {EffectFactories, PresetMeta} from "@opendaw/studio-core"

// The scripts index published to assets.opendaw.studio/community/scripts/index.json by the opendaw-commons deploy
export const CommunityScriptTargets = ["project", "werkstatt", "apparat", "spielwerk"] as const

export type CommunityScriptTarget = typeof CommunityScriptTargets[number]

export type CommunityAuthor = {
    readonly name: string
    readonly github?: string
    readonly url?: string
}

export type CommunityScript = {
    readonly uuid: string
    readonly slug: string
    readonly name: string
    readonly description: string
    readonly author: CommunityAuthor
    readonly tags: ReadonlyArray<string>
    readonly license: string
    readonly url: string
    readonly size: number
    readonly created: number
    readonly modified: number
    readonly source: string
    readonly minApi: number
    readonly target: CommunityScriptTarget
    readonly language: "ts" | "js"
    readonly screenshot?: string
}

export const CommunityPresetCategories = ["instrument", "audio-effect", "midi-effect", "audio-unit"] as const

export type CommunityPresetCategory = typeof CommunityPresetCategories[number]

export type CommunityPreset = {
    readonly uuid: string
    readonly slug: string
    readonly name: string
    readonly description: string
    readonly author: CommunityAuthor
    readonly tags: ReadonlyArray<string>
    readonly license: string
    readonly credits: string
    readonly category: CommunityPresetCategory
    readonly device: string
    readonly folder: string
    readonly hasTimeline?: boolean
    readonly url: string
    readonly size: number
    readonly created: number
    readonly modified: number
    readonly source: string
}

export type CommunityScriptIndex = {
    readonly version: 1
    readonly updatedAt?: string
    readonly scripts: ReadonlyArray<CommunityScript>
}

// the device keys this Studio knows, passed in so the index stays free of the engine imports
export type PresetDevices = {
    readonly isInstrument: (key: string) => key is InstrumentFactories.Keys
    readonly isAudioEffect: (key: string) => key is EffectFactories.AudioEffectKeys
    readonly isMidiEffect: (key: string) => key is EffectFactories.MidiEffectKeys
}

export namespace CommunityIndex {
    // raised whenever an index entry needs a newer Studio, entries above it are hidden
    export const ApiLevel = 1

    export const EmptyScripts: CommunityScriptIndex = {version: 1, scripts: []}

    const Author = z.object({name: z.string(), github: z.string().optional(), url: z.string().optional()})

    const Script = z.object({
        uuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        slug: z.string().min(1),
        name: z.string(),
        description: z.string(),
        author: Author,
        tags: z.array(z.string()),
        license: z.string(),
        url: z.string().regex(/^[A-Za-z0-9.-]+$/),
        size: z.number(),
        created: z.number(),
        modified: z.number(),
        source: z.string(),
        minApi: z.number(),
        target: z.enum(CommunityScriptTargets),
        language: z.enum(["ts", "js"]),
        screenshot: z.string().regex(/^[A-Za-z0-9.-]+$/).optional()
    })

    const Preset = z.object({
        uuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        slug: z.string().min(1),
        name: z.string(),
        description: z.string(),
        author: Author,
        tags: z.array(z.string()),
        license: z.string(),
        credits: z.string(),
        category: z.enum(CommunityPresetCategories),
        device: z.string(),
        folder: z.string(),
        hasTimeline: z.boolean().optional(),
        url: z.string().regex(/^[A-Za-z0-9.-]+$/),
        size: z.number(),
        created: z.number(),
        modified: z.number(),
        source: z.string()
    })

    const Envelope = z.object({version: z.literal(1), updatedAt: z.string().optional(), scripts: z.array(z.unknown())})

    const PresetEnvelope = z.object({version: z.literal(1), presets: z.array(z.unknown())})

    export const parsePresets = (json: unknown): ReadonlyArray<CommunityPreset> =>
        PresetEnvelope.parse(json).presets
            .map(entry => Preset.safeParse(entry))
            .filter(result => result.success)
            .map(result => result.data)

    // one entry this Studio does not understand (newer target, newer api) is skipped, never the whole index
    export const parseScripts = (json: unknown): CommunityScriptIndex => {
        const {version, updatedAt, scripts} = Envelope.parse(json)
        const parsed = scripts
            .map(entry => Script.safeParse(entry))
            .filter(result => result.success)
            .map(result => result.data)
            .filter(entry => entry.minApi <= ApiLevel)
        return {version, updatedAt, scripts: parsed}
    }

    // a device this Studio does not know yet hides the preset
    export const toPresetMeta = (entry: CommunityPreset,
                                 {isInstrument, isAudioEffect, isMidiEffect}: PresetDevices): Option<PresetMeta> => {
        const {uuid, name, description, created, modified, hasTimeline, tags, author, license, credits, folder, device} = entry
        if (!UUID.validateString(uuid)) {return Option.None}
        const common = {
            uuid, name, description, created, modified, hasTimeline, tags, author: author.name, license,
            credits: credits.length > 0 ? credits : undefined, folder: folder.length > 0 ? folder : undefined
        }
        switch (entry.category) {
            case "instrument":
                return isInstrument(device) ? Option.wrap({...common, category: "instrument", device}) : Option.None
            case "audio-effect":
                return isAudioEffect(device) ? Option.wrap({...common, category: "audio-effect", device}) : Option.None
            case "midi-effect":
                return isMidiEffect(device) ? Option.wrap({...common, category: "midi-effect", device}) : Option.None
            case "audio-unit":
                return isInstrument(device) ? Option.wrap({...common, category: "audio-unit", instrument: device}) : Option.None
        }
    }
}
