import {z} from "zod"
import {Browser} from "@opendaw/lib-dom"

export const FpsOptions = [24, 25, 29.97, 30] as const
export const OverlappingRegionsBehaviourOptions = ["clip", "push-existing", "keep-existing"] as const

export const StudioSettingsSchema = z.object({
    "visibility": z.object({
        "visible-help-hints": z.boolean(),
        "enable-history-buttons": z.boolean(),
        "auto-open-clips": z.boolean(),
        "scrollbar-padding": z.boolean()
    }).default({
        "visible-help-hints": true,
        "enable-history-buttons": navigator.maxTouchPoints > 0,
        "auto-open-clips": true,
        "scrollbar-padding": Browser.isWindows()
    }),
    "time-display": z.object({
        "musical": z.boolean(),
        "absolute": z.boolean(),
        "details": z.boolean(),
        "fps": z.union(FpsOptions.map(value => z.literal(value)))
    }).default({musical: true, absolute: false, details: false, fps: 25}),
    "engine": z.object({
        "note-audition-while-editing": z.boolean(),
        "auto-create-output-compressor": z.boolean()
    }).default({
        "note-audition-while-editing": true,
        "auto-create-output-compressor": true
    }),
    "pointer": z.object({
        "dragging-use-pointer-lock": z.boolean(),
        "modifying-controls-wheel": z.boolean(),
        "normalize-mouse-wheel": z.boolean()
    }).default({
        "dragging-use-pointer-lock": false,
        "modifying-controls-wheel": false,
        "normalize-mouse-wheel": true
    }),
    "editing": z.object({
        "overlapping-regions-behaviour": z.enum(OverlappingRegionsBehaviourOptions),
        "show-clipboard-menu": z.boolean()
    }).default({
        "overlapping-regions-behaviour": "clip",
        "show-clipboard-menu": false
    }),
    "debug": z.object({
        "footer-show-fps-meter": z.boolean(),
        "footer-show-samples-memory": z.boolean(),
        "footer-show-build-infos": z.boolean(),
        "enable-beta-features": z.boolean(),
        "enable-debug-menu": z.boolean()
    }).default({
        "footer-show-fps-meter": false,
        "footer-show-samples-memory": false,
        "footer-show-build-infos": false,
        "enable-beta-features": false,
        "enable-debug-menu": false
    }),
    "storage": z.object({
        "auto-delete-orphaned-samples": z.boolean()
    }).default({
        "auto-delete-orphaned-samples": false
    })
})

export type StudioSettings = z.infer<typeof StudioSettingsSchema>