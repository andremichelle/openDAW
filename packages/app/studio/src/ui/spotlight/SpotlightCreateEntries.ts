import {Option} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {DeviceFactory, DeviceHost, Devices, InstrumentFactories, InstrumentFactory} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory, PresetEntry, Project} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"
import {CommunityScript, CommunityScriptTarget} from "@/opendaw-api/CommunityIndex"
import {WclapDescriber} from "@/service/WclapDescriber"
import {SpotlightEntry} from "@/ui/spotlight/SpotlightEntry"
import {SpotlightCreate} from "@/ui/spotlight/SpotlightCreate"

const enum Group {Device, Plugin, UserPreset, StockPreset, Script}

type Accepts = "audio" | "midi"

type Owned = { readonly owner: Option<DeviceFactory>, readonly entry: SpotlightEntry }

const instrumentOf = (key: string): Option<InstrumentFactory> =>
    Option.wrap((InstrumentFactories.Named as Record<string, InstrumentFactory>)[key])

const effectOf = (key: string): Option<EffectFactory> =>
    Option.wrap((EffectFactories.MergedNamed as Record<string, EffectFactory>)[key])

const scriptDevices: Record<Exclude<CommunityScriptTarget, "project">, [DeviceFactory, Option<Accepts>]> = {
    apparat: [InstrumentFactories.Named.Apparat, Option.None],
    werkstatt: [EffectFactories.AudioNamed.Werkstatt, Option.wrap("audio")],
    spielwerk: [EffectFactories.MidiNamed.Spielwerk, Option.wrap("midi")]
}

export namespace SpotlightCreateEntries {
    export const collect = (service: StudioService, scripts: ReadonlyArray<CommunityScript>,
                            wclaps: ReadonlyArray<SpotlightCreate.Wclap>): ReadonlyArray<SpotlightEntry> => {
        const blocked = effectBlocker(service.hasProfile ? Option.wrap(service.project) : Option.None)
        const create = (label: string, names: ReadonlyArray<string>, qualifiers: ReadonlyArray<string>, icon: IconSymbol,
                        detail: string, group: Group, disabled: Option<string>, run: () => void,
                        children: ReadonlyArray<SpotlightEntry> = []): SpotlightEntry => ({
            verb: "create", label, names, qualifiers, icon, detail, group, disabled, children, run
        })
        const presets = service.presets.presets().flatMap((entry: PresetEntry): ReadonlyArray<Owned> => {
            const group = entry.source === "user" ? Group.UserPreset : Group.StockPreset
            const source = entry.source === "user" ? "User" : "Stock"
            switch (entry.category) {
                case "instrument":
                case "audio-unit": {
                    const key = entry.category === "instrument" ? entry.device : entry.instrument
                    const kind = entry.category === "instrument" ? "Preset" : "Rack"
                    return instrumentOf(key).match({
                        none: () => [],
                        some: factory => [{owner: Option.wrap(factory), entry: create(`Create ${factory.defaultName} · ${entry.name}`,
                            [entry.name], [factory.defaultName], factory.defaultIcon, `${source} ${kind}`, group, Option.None,
                            () => SpotlightCreate.preset(service, entry))}]
                    })
                }
                case "audio-effect":
                case "midi-effect":
                    return effectOf(entry.device).match({
                        none: () => [],
                        some: factory => [{owner: Option.wrap(factory), entry: create(`Create ${factory.defaultName} · ${entry.name}`,
                            [entry.name], [factory.defaultName], factory.defaultIcon, `${source} Preset`, group,
                            blocked(factory.type), () => SpotlightCreate.preset(service, entry))}]
                    })
                case "audio-effect-chain":
                    return [{owner: Option.None, entry: create(`Create Audio Effect Chain · ${entry.name}`, [entry.name],
                        ["Audio Effect Chain"], EffectFactories.AudioNamed.AudioEffectComposite.defaultIcon,
                        `${source} Chain`, group, blocked("audio"), () => SpotlightCreate.preset(service, entry))}]
                case "midi-effect-chain":
                    return [{owner: Option.None, entry: create(`Create MIDI Effect Chain · ${entry.name}`, [entry.name],
                        ["MIDI Effect Chain"], EffectFactories.MidiNamed.Arpeggio.defaultIcon,
                        `${source} Chain`, group, blocked("midi"), () => SpotlightCreate.preset(service, entry))}]
            }
        })
        const scriptEntries = scripts.flatMap((script): ReadonlyArray<Owned> => {
            if (script.target === "project") {return []}
            const [factory, accepts] = scriptDevices[script.target]
            return [{owner: Option.wrap(factory), entry: create(`Create ${factory.defaultName} with ${script.name} script`,
                [script.name], [factory.defaultName, ...script.tags], factory.defaultIcon,
                `Script by ${script.author.name}`, Group.Script, accepts.flatMap(blocked),
                () => SpotlightCreate.script(service, script))}]
        })
        const wclapEntries = wclaps.flatMap((wclap): ReadonlyArray<SpotlightEntry> => {
            const {name, info} = wclap
            const vendor = info.vendor.length > 0 ? ` · ${info.vendor}` : ""
            switch (WclapDescriber.kindOf(info)) {
                case "instrument":
                    return [create(`Create WebCLAP · ${name}`, [name, "WebCLAP"], [info.vendor], IconSymbol.WebClap,
                        `WebCLAP Instrument${vendor}`, Group.Plugin, Option.None, () => SpotlightCreate.wclap(service, wclap))]
                case "audio-effect":
                    return [create(`Create WebCLAP · ${name}`, [name, "WebCLAP"], [info.vendor], IconSymbol.WebClap,
                        `WebCLAP Effect${vendor}`, Group.Plugin, blocked("audio"), () => SpotlightCreate.wclap(service, wclap))]
                case "note-effect":
                    return []
            }
        })
        const owned = [...presets, ...scriptEntries]
        const childrenOf = (factory: DeviceFactory): ReadonlyArray<SpotlightEntry> =>
            owned.filter(({owner}) => owner.contains(factory)).map(({entry}) => entry)
        const instruments = InstrumentFactories.Sorted.map(([, factory]) => create(`Create ${factory.defaultName}`,
            [factory.defaultName, factory.briefDescription], [], factory.defaultIcon, "Instrument", Group.Device,
            Option.None, () => SpotlightCreate.instrument(service, factory), childrenOf(factory)))
        const effects = [...EffectFactories.AudioList, ...EffectFactories.MidiList].map(factory => create(
            `Create ${factory.defaultName}`, [factory.defaultName, factory.briefDescription], [], factory.defaultIcon,
            factory.type === "audio" ? "Audio Effect" : "MIDI Effect", Group.Device, blocked(factory.type),
            () => SpotlightCreate.effect(service, factory), childrenOf(factory)))
        return [...instruments, ...effects, ...wclapEntries, ...owned.map(({entry}) => entry)]
    }

    const effectBlocker = (project: Option<Project>) => {
        const host: Option<DeviceHost> = project.flatMap(({userEditingManager, boxAdapters}) => userEditingManager.audioUnit.get()
            .map(vertex => boxAdapters.adapterFor(vertex.box, Devices.isHost)))
        return (accepts: Accepts): Option<string> => host.match({
            none: () => Option.wrap("Select an audio unit first"),
            some: host => DeviceHost.takesEffect(host, accepts) ? Option.None
                : Option.wrap(accepts === "midi" ? "Takes no MIDI effects" : "Takes no audio effects")
        })
    }
}
