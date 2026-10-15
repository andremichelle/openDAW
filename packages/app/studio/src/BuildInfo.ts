// This JSON gets created right before building (check ../vite.config.ts) and stored in the public folder.
import {z} from "zod"

export const BuildInfo = z.object({
    date: z.number(),
    uuid: z.string(),
    env: z.enum(["production", "development"]),
    shellApi: z.number().optional()
})

export type BuildInfo = z.infer<typeof BuildInfo>