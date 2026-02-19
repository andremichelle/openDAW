import {z} from "zod"

export const SampleMetaData = z.object({
    name: z.string(),
    bpm: z.number(),
    duration: z.number(),
    sample_rate: z.number(),
    origin: z.enum(["openDAW", "recording", "import"]),
    custom: z.string().optional()
})

export type SampleMetaData = z.infer<typeof SampleMetaData>