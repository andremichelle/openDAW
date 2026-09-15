import {Procedure} from "@opendaw/lib-std"
import {Workspace} from "@/ui/workspace/Workspace"
import {StudioService} from "@/service/StudioService"
import {BrowseScope} from "@/ui/browse/BrowseScope"
import {TourAnchor} from "./TourAnchor"
import {TourPlacement} from "./TourPlacement"

export type TourStep = {
    screen: Workspace.ScreenKeys
    placement: TourPlacement
    frame?: number
    headline: string
    text: string
    prepare?: Procedure<StudioService>
}

const browse = (scope: BrowseScope): Procedure<StudioService> => service => service.layout.browseScope.setValue(scope)

// Keys are the anchors. A key without a registered element shows a centered card.
export const TourSteps: Record<TourAnchor, TourStep> = {
    menu: {
        screen: "default", placement: "below", frame: 8, headline: "openDAW Menu",
        text: "Create, open, save and export projects here. Preferences and the debug tools live here too."
    },
    manuals: {
        screen: "default", placement: "below", frame: 6, headline: "Manuals",
        text: "Opens the manuals in a separate tab whenever you need more than this tour."
    },
    midi: {
        screen: "default", placement: "below", frame: 6, headline: "MIDI",
        text: "Enable MIDI access to play with a keyboard or controller. The capture button learns a controller for the knob you touch next."
    },
    transport: {
        screen: "default", placement: "below", frame: 4, headline: "Transport",
        text: "Play, stop, record and loop. The metronome and count-in sit right next to it."
    },
    timecodes: {
        screen: "default", placement: "below", frame: 2, headline: "Timecodes",
        text: "Shows where you are in bars and in time. Click a field to type a new position."
    },
    screens: {
        screen: "default", placement: "below", frame: 4, headline: "Screens",
        text: "Switch between the arrangement, mixer, modulation and the special views. Each has a keyboard shortcut."
    },
    presets: {
        screen: "default", placement: "right", headline: "Presets",
        text: "Instruments and effects ready to drop onto the timeline or into a device chain.",
        prepare: browse(BrowseScope.Presets)
    },
    samples: {
        screen: "default", placement: "right", headline: "Samples",
        text: "Your audio files. Drag one onto the timeline to create a track, or onto a sampler.",
        prepare: browse(BrowseScope.Samples)
    },
    soundfonts: {
        screen: "default", placement: "right", headline: "Soundfonts",
        text: "General MIDI style instrument banks. Drag one to the timeline like a preset.",
        prepare: browse(BrowseScope.Soundfonts)
    },
    clips: {
        screen: "default", placement: "right", headline: "Clips",
        text: "Launch loops per track without arranging them. Great for sketching ideas live.",
        prepare: service => service.timeline.clips.visible.setValue(true)
    },
    regions: {
        screen: "default", placement: "above", headline: "Regions",
        text: "The arrangement. Draw, move, loop and edit notes and audio on the tracks."
    },
    devices: {
        screen: "default", placement: "center", headline: "Devices",
        text: "The instrument and effect chain of the selected track. Every knob can be automated or modulated."
    },
    mixer: {
        screen: "mixer", placement: "right", headline: "Mixer",
        text: "Levels, panning, sends and routing for every track and bus."
    },
    analysis: {
        screen: "mixer", placement: "center", headline: "Analysis",
        text: "Meters, spectrum, spectrogram and scope of what you are listening to."
    },
    modulation: {
        screen: "modulation", placement: "center", headline: "Modulation",
        text: "All modulators and what they drive. Connect an LFO or envelope to any parameter."
    },
    piano: {
        screen: "piano", placement: "center", headline: "Piano Tutorial Mode",
        text: "Shows the notes of the selected track falling onto a piano. Play along."
    },
    project: {
        screen: "project", placement: "center", headline: "Project Info",
        text: "Name, cover and notes of your project. Everything you save goes with the project."
    },
    shadertoy: {
        screen: "shadertoy", placement: "center", headline: "Shadertoy",
        text: "A GLSL visual that reacts to your music. Edit the shader on the right, watch it on the left."
    },
    tap: {
        screen: "tap", placement: "center", headline: "Match Tempo",
        text: "Tap along to find the tempo of a recording and set it for the project."
    }
}
