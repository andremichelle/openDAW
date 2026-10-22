import {EmptyExec, Option} from "@opendaw/lib-std"
import {RouteLocation} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import type {StudioService} from "@/service/StudioService"
import {Workspace} from "@/ui/workspace/Workspace"
import {DefaultWorkspace} from "@/ui/workspace/Default"
import {openManual} from "@/ui/manuals"
import {connectRoom} from "@/service/StudioLiveRoomConnect"
import {NeuralDemux} from "@/service/NeuralDemux"
import {SpotlightEntry} from "@/ui/spotlight/SpotlightEntry"

type Place = { readonly name: string, readonly keywords: ReadonlyArray<string>, readonly icon: IconSymbol, readonly open: () => void }

const screens: ReadonlyArray<[Workspace.ScreenKeys, string, ReadonlyArray<string>]> = [
    ["default", "Arrangement", ["Timeline", "Tracks"]],
    ["mixer", "Mixer", []],
    ["modulation", "Modulation", []],
    ["piano", "Piano Tutorial Mode", []],
    ["project", "Project Info", []],
    ["shadertoy", "Shadertoy", ["Visualizer"]],
    ["tap", "Match Tempo", ["Tap"]]
]

export namespace SpotlightStudioEntries {
    export const places = (service: StudioService): ReadonlyArray<SpotlightEntry> => {
        const navigate = (path: string) => () => RouteLocation.get().navigateTo(path)
        const places: ReadonlyArray<Place> = [
            {name: "Dashboard", keywords: ["Home", "Projects"], icon: IconSymbol.OpenDAW, open: () => service.switchScreen("dashboard")},
            {name: "Scripting", keywords: ["Code Editor"], icon: IconSymbol.Code, open: navigate("/scripting")},
            {name: "Preferences", keywords: ["Settings"], icon: IconSymbol.System, open: navigate("/preferences")},
            {name: "Storage", keywords: ["Samples", "Files"], icon: IconSymbol.Folder, open: navigate("/storage")},
            {name: "Manuals", keywords: ["Help", "Documentation"], icon: IconSymbol.Book, open: () => openManual("/manuals/")},
            {name: "Manifesto", keywords: [], icon: IconSymbol.Heart, open: navigate("/manifesto")},
            {name: "Privacy", keywords: [], icon: IconSymbol.Lock, open: navigate("/privacy")},
            {name: "Imprint", keywords: [], icon: IconSymbol.Info, open: navigate("/imprint")}
        ]
        const placeEntries = places.map(({name, keywords, icon, open}): SpotlightEntry => ({
            verb: "goto", label: `Go to ${name}`, names: [name, ...keywords], qualifiers: [], icon, detail: "Place",
            group: 0, disabled: Option.None, children: [], run: open
        }))
        const screenEntries = screens.map(([key, name, keywords]): SpotlightEntry => ({
            verb: "goto", label: `Go to ${name}`, names: [name, ...keywords], qualifiers: [], icon: DefaultWorkspace[key].icon,
            detail: "Screen", group: 0, disabled: service.hasProfile ? Option.None : Option.wrap("Open a project first"),
            children: [], run: () => service.switchScreen(key)
        }))
        return [...placeEntries, ...screenEntries]
    }

    export const actions = (service: StudioService): ReadonlyArray<SpotlightEntry> => [
        {name: "Project", keywords: ["New Project", "Empty"], icon: IconSymbol.New, run: () => service.newProject()},
        {name: "Live Room", keywords: ["New Live Room", "Jam", "Session"], icon: IconSymbol.Connected, run: () => connectRoom(service)}
    ].map(({name, keywords, icon, run}): SpotlightEntry => ({
        verb: "create", label: `Create New ${name}`, names: [name, ...keywords], qualifiers: [], icon, detail: "Studio",
        group: 0, disabled: Option.None, children: [], run: () => {run().catch(EmptyExec)}
    }))

    export const opens = (service: StudioService): ReadonlyArray<SpotlightEntry> => {
        const items: ReadonlyArray<[string, ReadonlyArray<string>, IconSymbol, () => Promise<unknown>]> = [
            ["Open Project...", ["Load", "Local"], IconSymbol.FolderOpen, () => service.browseLocalProjects()],
            ["Open Bundle...", ["Load", "odb", "File"], IconSymbol.Folder, () => service.importBundle()],
            ["Import Audio Files...", ["Samples", "Wav"], IconSymbol.AudioFile, () => service.sampleService.browse(true)],
            ["Import Stems...", ["Zip"], IconSymbol.Stack, () => service.importStems()],
            ["Import Soundfont Files...", ["sf2"], IconSymbol.SoundFont, () => service.soundfontService.browse(true)],
            ["Import Preset Bundle...", ["Presets"], IconSymbol.Box, () => service.importPreset()],
            ["Import DAWproject...", ["Bitwig", "Studio One"], IconSymbol.FileList, () => service.importDawproject()],
            ["Neural Demux...", ["Split", "Separate", "Stems"], IconSymbol.Robot, () => NeuralDemux.run(service)]
        ]
        return items.map(([label, keywords, icon, run]): SpotlightEntry => ({
            verb: "open", label, names: [label, ...keywords], qualifiers: [], icon, detail: "Studio",
            group: 0, disabled: Option.None, children: [], run: () => {run().catch(EmptyExec)}
        }))
    }
}
