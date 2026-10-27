import {z} from "zod"

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

export type CommunityScriptIndex = {
    readonly version: 1
    readonly updatedAt?: string
    readonly scripts: ReadonlyArray<CommunityScript>
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

    const Envelope = z.object({version: z.literal(1), updatedAt: z.string().optional(), scripts: z.array(z.unknown())})

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
}
