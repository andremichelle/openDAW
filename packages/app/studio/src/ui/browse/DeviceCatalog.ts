import {asInstanceOf, Bytes, int, isDefined, Option, Optional, StringComparator} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {IconSymbol} from "@opendaw/studio-enums"
import {WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, InstrumentFactory, PresetDecoder, ScriptCompiler} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory, PresetEntry, Project, WclapStates} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"
import {CommunityAPI} from "@/opendaw-api/CommunityAPI"
import {CommunityScript} from "@/opendaw-api/CommunityIndex"
import {WclapDescriber} from "@/service/WclapDescriber"
import {deviceKeyOf} from "@/ui/browse/PresetService"
import {PresetApplication} from "@/ui/browse/PresetApplication"
import {DeviceSlot} from "@/ui/browse/DeviceSlot"
import {DeviceTags} from "@/ui/browse/DeviceTags"
import {SpotlightCreate} from "@/ui/spotlight/SpotlightCreate"
import {ScriptCompilers} from "@/ui/devices/ScriptCompilers"

// a device, preset, script or plugin applied at a slot: `apply` runs inside an unmarked modify, `settle` after it
export interface DeviceCandidate {
    readonly offersTimeline: boolean
    apply(project: Project, slot: DeviceSlot, keepTimeline: boolean): boolean
    settle(service: StudioService): Promise<void>
}

export type DeviceEntryKind = "device" | "user-preset" | "stock-preset" | "script" | "wclap"

export type DeviceFact = { readonly label: string, readonly value: string }

export type DeviceBundle = "rack" | "chain"

export type DeviceEntry = {
    readonly key: string
    readonly kind: DeviceEntryKind
    readonly local: boolean
    readonly name: string
    readonly brief: string
    readonly caption: string
    readonly description: string
    readonly icon: IconSymbol
    readonly iconUrl: Option<string>
    readonly deviceKey: string
    readonly facts: ReadonlyArray<DeviceFact>
    readonly tags: ReadonlyArray<string>
    readonly preset: Option<PresetEntry>
    readonly bundle: Option<DeviceBundle>
    readonly prepare: () => Promise<DeviceCandidate>
}

export namespace DeviceCatalog {
    export type Sources = {
        readonly presets: ReadonlyArray<PresetEntry>
        readonly scripts: ReadonlyArray<CommunityScript>
        readonly wclaps: ReadonlyArray<SpotlightCreate.Wclap>
    }

    type Stock = {
        readonly key: string
        readonly name: string
        readonly icon: IconSymbol
        readonly iconUrl: Option<string>
        readonly brief: string
        readonly description: string
        readonly kindLabel: string
        readonly apply: (project: Project, slot: DeviceSlot) => Option<Box>
    }

    const rankOf: Record<DeviceEntryKind, int> = {"device": 0, "user-preset": 1, "stock-preset": 2, "script": 3, "wclap": 4}

    export const compare = (left: DeviceEntry, right: DeviceEntry): int => {
        const order = StringComparator(left.name.toLowerCase(), right.name.toLowerCase())
        return order !== 0 ? order : rankOf[left.kind] - rankOf[right.kind]
    }

    const effectStock = (key: string, factory: EffectFactory, kindLabel: string): Stock => ({
        key, name: factory.defaultName, icon: factory.defaultIcon,
        iconUrl: factory.external ? Option.wrap("/images/tone3000.svg") : Option.None,
        brief: factory.briefDescription, description: factory.description, kindLabel,
        apply: (project, slot) => DeviceSlot.placeEffect(slot, (field, index) => project.api.insertEffect(field, factory, index))
    })

    const stocksFor = (slot: DeviceSlot): ReadonlyArray<Stock> => {
        switch (DeviceSlot.categoryOf(slot)) {
            case "audio-effect":
                return Object.entries(EffectFactories.AudioNamed).map(([key, factory]) => effectStock(key, factory, "Stock audio effect"))
            case "midi-effect":
                return Object.entries(EffectFactories.MidiNamed).map(([key, factory]) => effectStock(key, factory, "Stock MIDI effect"))
            case "instrument":
                return InstrumentFactories.Sorted
                    .filter(([_key, factory]) => DeviceSlot.acceptsInstrument(slot, factory))
                    .map(([key, factory]) => ({
                        key, name: factory.defaultName, icon: factory.defaultIcon, iconUrl: Option.None,
                        brief: factory.briefDescription, description: factory.description, kindLabel: "Stock instrument",
                        apply: (project, slot) => DeviceSlot.placeInstrument(project, slot, factory)
                    }))
        }
    }

    const plainCandidate = (apply: (project: Project, slot: DeviceSlot) => boolean): DeviceCandidate => ({
        offersTimeline: false,
        apply: (project, slot) => apply(project, slot),
        settle: () => Promise.resolve()
    })

    const deviceEntry = (stock: Stock): DeviceEntry => ({
        key: `device:${stock.key}`, kind: "device", local: false, name: stock.name, brief: stock.brief,
        caption: stock.kindLabel, description: stock.description, icon: stock.icon, iconUrl: stock.iconUrl,
        deviceKey: stock.key, facts: [], tags: DeviceTags.of(stock.key), preset: Option.None, bundle: Option.None,
        prepare: () => Promise.resolve(plainCandidate((project, slot) => stock.apply(project, slot).nonEmpty()))
    })

    type PresetLook = {
        readonly caption: string
        readonly icon: IconSymbol
        readonly iconUrl: Option<string>
        readonly deviceKey: string
        readonly facts: ReadonlyArray<DeviceFact>
        readonly tags: ReadonlyArray<string>
        readonly bundle: Option<DeviceBundle>
        readonly apply: (project: Project, slot: DeviceSlot, bytes: ArrayBuffer, keepTimeline: boolean) => boolean
    }

    const presetEntryWith = (slot: DeviceSlot, entry: PresetEntry, look: PresetLook): DeviceEntry => {
        const user = entry.source === "user"
        return {
            key: `preset:${entry.source}:${entry.uuid}`, kind: user ? "user-preset" : "stock-preset", local: user,
            name: entry.name, brief: entry.description, caption: `${user ? "User" : "Stock"} ${look.caption}`,
            description: entry.description, icon: look.icon, iconUrl: look.iconUrl, deviceKey: look.deviceKey,
            facts: look.facts, tags: [...(entry.tags ?? []), ...look.tags], preset: Option.wrap(entry),
            bundle: look.bundle,
            prepare: async () => {
                const bytes = await PresetApplication.fetchBytes(entry.uuid, entry.source)
                return {
                    offersTimeline: DeviceSlot.hasTimeline(slot) && PresetDecoder.peekHasTimeline(bytes),
                    apply: (project, slot, keepTimeline) => look.apply(project, slot, bytes, keepTimeline),
                    settle: async service => service.project.loadScriptDevices()
                }
            }
        }
    }

    const timelineFact = (entry: PresetEntry): DeviceFact =>
        ({label: "Timeline", value: entry.hasTimeline === true ? "Included" : "None"})

    const presetEntry = (slot: DeviceSlot, entry: PresetEntry, stock: Stock): DeviceEntry =>
        presetEntryWith(slot, entry, {
            caption: `preset for ${stock.name}`, icon: stock.icon, iconUrl: stock.iconUrl, deviceKey: stock.key,
            facts: [{label: "Device", value: stock.name}], tags: DeviceTags.of(stock.key), bundle: Option.None,
            apply: (project, slot, bytes, keepTimeline) =>
                DeviceSlot.placePreset(project, slot, bytes, deviceKeyOf(entry), keepTimeline)
        })

    const rackEntry = (slot: DeviceSlot, entry: PresetEntry, instrument: InstrumentFactory): DeviceEntry =>
        presetEntryWith(slot, entry, {
            caption: `rack with ${instrument.defaultName}`, icon: instrument.defaultIcon, iconUrl: Option.None,
            deviceKey: deviceKeyOf(entry), facts: [{label: "Instrument", value: instrument.defaultName}, timelineFact(entry)],
            tags: ["rack"], bundle: Option.wrap("rack"), apply: DeviceSlot.placeRack
        })

    const chainEntry = (slot: DeviceSlot, entry: PresetEntry, label: string): DeviceEntry =>
        presetEntryWith(slot, entry, {
            caption: `${label} chain`, icon: IconSymbol.Chain, iconUrl: Option.None, deviceKey: "",
            facts: [], tags: ["chain"], bundle: Option.wrap("chain"),
            apply: (project, slot, bytes, keepTimeline) => DeviceSlot.placePreset(project, slot, bytes, "", keepTimeline)
        })

    const scriptEntry = (script: CommunityScript, target: SpotlightCreate.ScriptTarget, host: Stock): DeviceEntry => ({
        key: `script:${script.uuid}`, kind: "script", local: false, name: script.name, brief: script.description,
        caption: `Community script for ${host.name}`, description: script.description, icon: host.icon,
        iconUrl: host.iconUrl, deviceKey: host.key,
        facts: [{label: "Author", value: script.author.name}, {label: "License", value: script.license}],
        tags: script.tags, preset: Option.None, bundle: Option.None,
        prepare: async () => {
            const source = await CommunityAPI.get().loadSource(script)
            const compiler = ScriptCompiler.create(ScriptCompilers[SpotlightCreate.scriptConfigs[target]])
            const userCode = compiler.stripHeader(source)
            const created: { box: Option<ScriptCompiler.ScriptDeviceBox> } = {box: Option.None}
            return {
                offersTimeline: false,
                apply: (project, slot) => {
                    created.box = host.apply(project, slot).map(box => box as ScriptCompiler.ScriptDeviceBox)
                    created.box.ifSome(box => box.code.setValue(userCode))
                    return created.box.nonEmpty()
                },
                settle: service => created.box.match({
                    none: () => Promise.resolve(),
                    some: box => compiler.compile(service.audioContext, service.project.editing, box, userCode, true)
                })
            }
        }
    })

    const wclapEntry = (wclap: SpotlightCreate.Wclap, instrument: boolean): DeviceEntry => ({
        key: `wclap:${wclap.id}:${wclap.info.clapId}`, kind: "wclap", local: wclap.local, name: wclap.name,
        brief: wclap.info.vendor, caption: `WebCLAP ${instrument ? "instrument" : "audio effect"} by ${wclap.info.vendor}`,
        description: "", icon: IconSymbol.WebClap, iconUrl: Option.None, deviceKey: "Wclap",
        facts: [
            {label: "Vendor", value: wclap.info.vendor},
            {label: "License", value: wclap.license.length > 0 ? wclap.license : "-"},
            {label: "Size", value: wclap.size > 0 ? Bytes.toString(wclap.size) : "-"},
            {label: "Stored", value: wclap.local ? "On this device" : "openDAW cloud"}
        ],
        tags: wclap.info.features, preset: Option.None, bundle: Option.None,
        prepare: async () => {
            const url = await SpotlightCreate.storeWclap(wclap)
            const {clapId, name} = wclap.info
            return plainCandidate((project, slot) => {
                const box: Option<WclapDeviceBox | WclapInstrumentBox> = instrument
                    ? DeviceSlot.placeInstrument(project, slot, InstrumentFactories.Wclap)
                        .map(box => asInstanceOf(box, WclapInstrumentBox))
                    : DeviceSlot.placeEffect(slot, (field, index) =>
                        project.api.insertEffect(field, EffectFactories.AudioNamed.Wclap, index))
                        .map(box => asInstanceOf(box, WclapDeviceBox))
                box.ifSome(box => {
                    box.url.setValue(url)
                    box.clapId.setValue(clapId)
                    WclapStates.name(project, box, undefined, name)
                })
                return box.nonEmpty()
            })
        }
    })

    export const entriesFor = (slot: DeviceSlot, {presets, scripts, wclaps}: Sources): ReadonlyArray<DeviceEntry> => {
        const category = DeviceSlot.categoryOf(slot)
        const stocks = stocksFor(slot)
        const stockByKey = new Map(stocks.map(stock => [stock.key, stock]))
        const scriptTarget: SpotlightCreate.ScriptTarget = category === "instrument" ? "apparat" : category === "audio-effect" ? "werkstatt" : "spielwerk"
        const scriptHost = stockByKey.get(SpotlightCreate.scriptConfigs[scriptTarget])
        const wclapKind = category === "instrument" ? "instrument" : category === "audio-effect" ? "audio-effect" : null
        return [
            ...stocks.map(deviceEntry),
            ...presets
                .filter(entry => entry.category === category)
                .flatMap(entry => {
                    const stock = stockByKey.get(deviceKeyOf(entry))
                    return isDefined(stock) ? [presetEntry(slot, entry, stock)] : []
                }),
            ...presets.flatMap(entry => {
                if (category === "instrument" && entry.category === "audio-unit") {
                    const factory: Optional<InstrumentFactory> = InstrumentFactories.Named[entry.instrument]
                    return isDefined(factory) && DeviceSlot.acceptsRack(slot, factory) ? [rackEntry(slot, entry, factory)] : []
                }
                if (category === "audio-effect" && entry.category === "audio-effect-chain") {return [chainEntry(slot, entry, "audio effect")]}
                if (category === "midi-effect" && entry.category === "midi-effect-chain") {return [chainEntry(slot, entry, "MIDI effect")]}
                return []
            }),
            ...(isDefined(scriptHost)
                ? scripts.filter(script => script.target === scriptTarget).map(script => scriptEntry(script, scriptTarget, scriptHost))
                : []),
            ...(isDefined(wclapKind) && stockByKey.has("Wclap")
                ? wclaps.filter(({info}) => WclapDescriber.kindOf(info) === wclapKind)
                    .map(wclap => wclapEntry(wclap, wclapKind === "instrument"))
                : [])
        ].toSorted(compare)
    }
}
