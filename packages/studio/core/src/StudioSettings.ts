import {z} from "zod"

export const FpsOptions = [24, 25, 29.97, 30] as const
export const OverlappingRegionsBehaviourOptions = ["clip", "push-existing", "keep-existing"] as const

export const StudioSettingsSchema = z.object({
    "visibility": z.object({
        "visible-help-hints": z.boolean(),
        "enable-history-buttons": z.boolean(),
        "base-frequency": z.boolean(),
        "toasts": z.boolean(),
        "show-output-track": z.boolean(),
        "offer-studio-tour": z.boolean()
    }).default({
        "visible-help-hints": true,
        "enable-history-buttons": navigator.maxTouchPoints > 0,
        "base-frequency": false,
        "toasts": true,
        "show-output-track": false,
        "offer-studio-tour": true
    }),
    "timeline": z.object({
        "markers": z.boolean(),
        "tempo": z.boolean(),
        "signature": z.boolean(),
        "clips": z.boolean(),
        "follow-cursor": z.boolean()
    }).default({
        "markers": true,
        "tempo": false,
        "signature": false,
        "clips": true,
        "follow-cursor": false
    }),
    "appearance": z.object({
        "neutral-hue": z.number().catch(197),
        "neutral-saturation": z.number().catch(100)
    }).default({
        "neutral-hue": 197,
        "neutral-saturation": 100
    }),
    "time-display": z.object({
        "musical": z.boolean(),
        "absolute": z.boolean(),
        "details": z.boolean(),
        "count-bars-from-zero": z.boolean(),
        "fps": z.union(FpsOptions.map(value => z.literal(value)))
    }).default({musical: true, absolute: false, details: false, "count-bars-from-zero": false, fps: 25}),
    "engine": z.object({
        "note-audition-while-editing": z.boolean(),
        "auto-create-output-maximizer": z.boolean(),
        "stop-playback-when-overloading": z.boolean(),
        "latency-warning-threshold": z.number().catch(25)
    }).default({
        "note-audition-while-editing": true,
        "auto-create-output-maximizer": true,
        "stop-playback-when-overloading": true,
        "latency-warning-threshold": 25
    }),
    "pointer": z.object({
        "dragging-use-pointer-lock": z.boolean(),
        "modifying-controls-wheel": z.boolean(),
        "wheel-zoom-speed": z.number().catch(100)
    }).default({
        "dragging-use-pointer-lock": false,
        "modifying-controls-wheel": false,
        "wheel-zoom-speed": 100
    }),
    "editing": z.object({
        "overlapping-regions-behaviour": z.enum(OverlappingRegionsBehaviourOptions),
        "show-clipboard-menu": z.boolean()
    }).default({
        "overlapping-regions-behaviour": "clip",
        "show-clipboard-menu": false
    }),
    "webclap": z.object({
        "default-zoom": z.number().catch(75)
    }).default({
        "default-zoom": 75
    }),
    "debug": z.object({
        "footer-show-fps-meter": z.boolean(),
        "footer-show-samples-memory": z.boolean(),
        "footer-show-build-infos": z.boolean(),
        "show-cpu-stats": z.boolean(),
        "enable-beta-features": z.boolean(),
        "enable-debug-menu": z.boolean()
    }).default({
        "footer-show-fps-meter": false,
        "footer-show-samples-memory": false,
        "footer-show-build-infos": false,
        "show-cpu-stats": false,
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