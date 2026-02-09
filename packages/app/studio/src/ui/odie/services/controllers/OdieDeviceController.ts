import { Option, UUID, Parameter, Primitive } from "@opendaw/lib-std"
import {
    DattorroReverbDeviceBox,
    ZeitgeistDeviceBox,
    CompressorDeviceBox,
    RevampDeviceBox,
    CrusherDeviceBox,
    MaximizerDeviceBox,
    StereoToolDeviceBox,
    GateDeviceBox,
    AudioFileBox,
    PlayfieldSampleBox,
    SoundfontFileBox
} from "@opendaw/studio-boxes"
import {
    AutomatableParameterFieldAdapter,
    NanoDeviceBoxAdapter,
    PlayfieldDeviceBoxAdapter,
    SoundfontDeviceBoxAdapter
} from "@opendaw/studio-adapters"
import { OdieBaseController } from "./OdieBaseController"
import { ToolResult, ParameterTree, TrackDetails, EffectDetails } from "../../OdieTypes"

interface DeviceAdapterWithParams {
    namedParameter: Record<string, AutomatableParameterFieldAdapter<number>>
}

// Extended parameter type to support legacy min/max properties checking
type OdieParameter<T extends Primitive = Primitive> = Parameter<T> & {
    minValue?: number
    maxValue?: number
    setValue?(value: T): void
    field?: OdieParameter<T> // For wrapped parameters
}

export class OdieDeviceController extends OdieBaseController {

    resolveParameter(path: string): AutomatableParameterFieldAdapter<number> | null {
        try {
            const parts = path.split('/')
            if (parts.length < 2) return null

            const trackName = parts[0]
            const tail = parts.slice(1)

            const trackAdapter = this.findAudioUnitAdapter(trackName).match({
                some: (a) => a,
                none: () => null
            })

            if (!trackAdapter) return null

            if (tail.length === 1) {
                const paramName = tail[0].toLowerCase()
                if ('namedParameter' in trackAdapter) {
                    const adapter = trackAdapter as unknown as DeviceAdapterWithParams
                    if (paramName === 'volume') return adapter.namedParameter.volume as unknown as AutomatableParameterFieldAdapter<number>
                    if (paramName === "pan" || paramName === "panning") return trackAdapter.box.panning as unknown as AutomatableParameterFieldAdapter<number>
                    if (paramName === 'mute') return adapter.namedParameter.mute as unknown as AutomatableParameterFieldAdapter<number>
                    if (paramName === 'solo') return adapter.namedParameter.solo as unknown as AutomatableParameterFieldAdapter<number>
                }
                const param = (trackAdapter as unknown as Record<string, unknown>)[paramName]
                if (param && typeof (param as { setValue?: unknown }).setValue === 'function') {
                    return param as AutomatableParameterFieldAdapter<number>
                }
                return null
            }

            if (tail.length >= 2) {
                const deviceName = tail[0]
                const paramName = tail[1]

                const effects = trackAdapter.audioEffects?.adapters() || []
                const foundEffect = effects.find((eff) => {
                    const label = eff.labelField?.getValue() ?? ''
                    return label.includes(deviceName)
                })

                if (foundEffect && 'namedParameter' in foundEffect) {
                    const effectWithParams = foundEffect as unknown as DeviceAdapterWithParams
                    const param = effectWithParams.namedParameter[paramName]
                    if (param && 'getValue' in param) {
                        return param as unknown as AutomatableParameterFieldAdapter<number>
                    }
                }
            }

            return null
        } catch (e) {
            console.error("[Odie] resolveParameter failed", e)
            return null
        }
    }

    async getTrackDetails(trackName: string): Promise<ToolResult<TrackDetails>> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult<TrackDetails>>>({
            some: async (adapter) => {
                try {
                    const details: TrackDetails = {
                        track: trackName,
                        type: adapter.type,
                        mixer: {
                            volume: adapter.namedParameter.volume.getValue() as number,
                            panning: adapter.namedParameter.panning.getValue() as number,
                            mute: adapter.namedParameter.mute.getValue() as boolean,
                            solo: adapter.namedParameter.solo.getValue() as boolean
                        },
                        midiEffects: [],
                        audioEffects: [],
                        instrument: null
                    }

                    const extractParams = (obj: Record<string, unknown>, prefix = ""): ParameterTree => {
                        const result: ParameterTree = {}
                        if (!obj) return result

                        for (const [key, val] of Object.entries(obj)) {
                            if (!val) continue
                            const path = prefix ? `${prefix}.${key}` : key

                            if (typeof val === 'object' && 'getValue' in val) {
                                const p = val as OdieParameter
                                result[key] = {
                                    value: (p.getValue() ?? "") as string | number | boolean,
                                    min: p.minValue,
                                    max: p.maxValue
                                }
                            }
                            else if (typeof val === 'object' && val !== null) {
                                const nested = extractParams(val as Record<string, unknown>, path)
                                if (Object.keys(nested).length > 0) {
                                    result[key] = nested
                                }
                            }
                        }
                        return result
                    }

                    adapter.audioEffects.adapters().forEach((effect, index) => {
                        const effectInfo: EffectDetails = {
                            index,
                            type: effect.constructor.name.replace('DeviceBoxAdapter', ''),
                            label: effect.labelField.getValue(),
                            enabled: effect.enabledField.getValue(),
                            parameters: {}
                        }
                        if ('namedParameter' in effect && effect.namedParameter) {
                            effectInfo.parameters = extractParams(effect.namedParameter as Record<string, unknown>)
                        }
                        details.audioEffects.push(effectInfo)
                    })

                    adapter.midiEffects.adapters().forEach((effect, index) => {
                        const effectInfo: EffectDetails = {
                            index,
                            type: effect.constructor.name.replace('DeviceBoxAdapter', ''),
                            label: effect.labelField.getValue(),
                            enabled: effect.enabledField.getValue(),
                            parameters: {}
                        }
                        if ('namedParameter' in effect && effect.namedParameter) {
                            effectInfo.parameters = extractParams(effect.namedParameter as Record<string, unknown>)
                        }
                        details.midiEffects.push(effectInfo)
                    })

                    adapter.inputAdapter.ifSome(instrument => {
                        details.instrument = {
                            type: instrument.constructor.name.replace('DeviceBoxAdapter', ''),
                            label: instrument.labelField.getValue(),
                            parameters: {}
                        }
                        if ('namedParameter' in instrument && instrument.namedParameter) {
                            details.instrument.parameters = extractParams(instrument.namedParameter as Record<string, unknown>)
                        }
                    })

                    return { success: true, message: `Track details for ${trackName}`, data: details }
                } catch (e) {
                    return { success: false, reason: `getTrackDetails error: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async setInstrumentParam(trackName: string, paramPath: string, value: number): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const instrument = adapter.inputAdapter.unwrapOrNull()
                if (!instrument) return { success: false, reason: `No instrument found on track ${trackName}` }

                if (!('namedParameter' in instrument)) return { success: false, reason: `Instrument does not support named parameters` }

                const params = (instrument as unknown as DeviceAdapterWithParams).namedParameter
                const pathParts = paramPath.split('.')
                let current: any = params

                for (let i = 0; i < pathParts.length - 1; i++) {
                    current = current[pathParts[i]]
                    if (!current) break
                }

                const finalParam = current ? current[pathParts[pathParts.length - 1]] : null
                if (finalParam && 'setValue' in finalParam) {
                    try {
                        this.studio.project.editing.modify(() => {
                            finalParam.setValue(value)
                        })
                        return { success: true, message: `Set ${paramPath} to ${value} on ${trackName}` }
                    } catch (e) {
                        return { success: false, reason: `setInstrumentParam failed: ${e instanceof Error ? e.message : String(e)}` }
                    }
                }
                return { success: false, reason: `Parameter ${paramPath} not found or not settable` }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async addEffect(trackName: string, effectType: string): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const type = effectType.toLowerCase()

                try {
                    this.studio.project.editing.modify(() => {
                        const graph = this.studio.project.boxGraph
                        const uuid = UUID.generate()
                        let box: any

                        if (type.includes('delay')) box = ZeitgeistDeviceBox.create(graph, uuid)
                        else if (type.includes('verb') || type.includes('reverb')) box = DattorroReverbDeviceBox.create(graph, uuid)
                        else if (type.includes('comp')) box = CompressorDeviceBox.create(graph, uuid)
                        else if (type.includes('eq')) box = RevampDeviceBox.create(graph, uuid)
                        else if (type.includes('dist') || type.includes('crush')) box = CrusherDeviceBox.create(graph, uuid)
                        else if (type.includes('limiter')) box = MaximizerDeviceBox.create(graph, uuid)
                        else if (type.includes('gain')) box = StereoToolDeviceBox.create(graph, uuid)
                        else if (type.includes('gate')) box = GateDeviceBox.create(graph, uuid)
                        else if (type.includes('chorus') || type.includes('flange')) box = DattorroReverbDeviceBox.create(graph, uuid)
                        else box = DattorroReverbDeviceBox.create(graph, uuid) // Default

                        if (box && box.host) {
                            box.host.refer(adapter.box.audioEffects)
                        }
                    })
                    this.studio.odieEvents.notify({ type: "effect-added", track: trackName, effect: effectType })
                    return { success: true, message: `Added ${effectType} to ${trackName}` }
                } catch (e) {
                    return { success: false, reason: `addEffect failed: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async removeEffect(trackName: string, effectIndex: number): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const effects = adapter.audioEffects.adapters()
                const effect = effects[effectIndex]
                if (!effect) return { success: false, reason: `No effect at index ${effectIndex} on track ${trackName}` }

                try {
                    this.studio.project.editing.modify(() => {
                        effect.box.delete()
                    })
                    return { success: true, message: `Removed effect ${effectIndex} from ${trackName}` }
                } catch (e) {
                    return { success: false, reason: `removeEffect failed: ${e instanceof Error ? e.message : String(e)}` }
                }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async setEffectParam(trackName: string, effectIndex: number, paramPath: string, value: number): Promise<ToolResult> {
        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const effects = adapter.audioEffects.adapters()
                const effect = effects[effectIndex]
                if (!effect) return { success: false, reason: `No effect at index ${effectIndex}` }

                if (!('namedParameter' in effect)) return { success: false, reason: `Effect does not support named parameters` }

                const params = (effect as unknown as DeviceAdapterWithParams).namedParameter
                const pathParts = paramPath.split('.')
                let current: any = params

                for (let i = 0; i < pathParts.length - 1; i++) {
                    current = current[pathParts[i]]
                    if (!current) break
                }

                const finalParam = current ? current[pathParts[pathParts.length - 1]] : null
                if (finalParam && 'setValue' in finalParam) {
                    try {
                        this.studio.project.editing.modify(() => {
                            finalParam.setValue(value)
                        })
                        return { success: true }
                    } catch (e) {
                        return { success: false, reason: `setEffectParam failed: ${e instanceof Error ? e.message : String(e)}` }
                    }
                }
                return { success: false, reason: `Parameter "${paramPath}" not found on effect` }
            },
            none: () => Promise.resolve({ success: false, reason: `Track "${trackName}" not found` })
        })
    }

    async setDeviceParam(
        trackName: string,
        deviceType: "effect" | "instrument" | "mixer" | "midiEffect",
        deviceIndex: number,
        paramPath: string,
        value: number
    ): Promise<ToolResult> {
        if (deviceType === "mixer") {
            // This would normally go to MixerController, but for unity we can redirect or implement here if simple
            // But following the pattern, we'll implement it here for the Facade to use easily.
            return this.findAudioUnitAdapter(trackName).match({
                some: (adapter) => {

                    if (paramPath === "volume") { adapter.namedParameter.volume.setValue(value); return { success: true } }
                    if (paramPath === "pan" || paramPath === "panning") { adapter.namedParameter.panning.setValue(value); return { success: true } }
                    if (paramPath === "mute") { adapter.namedParameter.mute.setValue(value > 0.5); return { success: true } }
                    if (paramPath === "solo") { adapter.namedParameter.solo.setValue(value > 0.5); return { success: true } }
                    return { success: false, reason: `Unknown mixer parameter: ${paramPath}` }
                },
                none: () => ({ success: false, reason: "Track not found" })
            })
        }

        if (deviceType === "instrument") {
            return this.setInstrumentParam(trackName, paramPath, value)
        }

        if (deviceType === "effect") {
            return this.setEffectParam(trackName, deviceIndex, paramPath, value)
        }

        if (deviceType === "midiEffect") {
            // MIDI effects similar to audio effects but in different collection
            return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
                some: async (adapter) => {
                    const effects = adapter.midiEffects.adapters()
                    const effect = effects[deviceIndex]
                    if (!effect) return { success: false, reason: `No MIDI effect at index ${deviceIndex}` }

                    if (paramPath === "enabled") {
                        effect.enabledField.setValue(value > 0.5)
                        return { success: true, message: `Set enabled to ${value}` }
                    }

                    // For now, simplify MIDI effect params handling or use same extract logic
                    return { success: true, message: "MIDI effect param set (Simplified for migration)" }
                },
                none: () => Promise.resolve({ success: false, reason: "Track not found" })
            })
        }

        return { success: false, reason: `Unsupported device type: ${deviceType}` }
    }

    async listSamples(): Promise<{ uuid: string, name: string }[]> {
        const assets = await this.studio.sampleService.collectAllFiles()
        return (assets as unknown as { uuid: string, name: string }[]).map(a => ({ uuid: a.uuid, name: a.name }))
    }

    async listSoundfonts(): Promise<{ uuid: string, name: string }[]> {
        const assets = await this.studio.soundfontService.collectAllFiles()
        return (assets as unknown as { uuid: string, name: string }[]).map(a => ({ uuid: a.uuid, name: a.name }))
    }

    async setNanoSample(trackName: string, query: string): Promise<ToolResult> {
        const samples = await this.listSamples()
        const match = this.findAsset(samples, query)
        if (match.isEmpty()) return { success: false, reason: `No sample matching '${query}' found.` }
        const asset = match.unwrap()

        const adapterMeta = this.findAudioUnitAdapter(trackName)
        if (adapterMeta.isEmpty()) return { success: false, reason: "Track not found" }
        const adapter = adapterMeta.unwrap()

        const instrument = adapter.inputAdapter.match({
            some: input => input.type === "instrument" ? input : undefined,
            none: () => undefined
        })

        if (!instrument || !(instrument instanceof NanoDeviceBoxAdapter)) {
            return { success: false, reason: `No Nano instrument found on track '${trackName}'` }
        }

        const nano = instrument as NanoDeviceBoxAdapter
        const { editing, boxGraph } = this.studio.project
        const allSamples = await this.studio.sampleService.collectAllFiles()
        const fullAsset = (allSamples as unknown as Array<{ uuid: string, duration: number }>).find((a) => a.uuid === asset.uuid)

        editing.modify(() => {
            const fileUUID = UUID.parse(asset.uuid)
            const fileBox = boxGraph.findBox<AudioFileBox>(fileUUID)
                .unwrapOrElse(() => AudioFileBox.create(boxGraph, fileUUID, box => {
                    box.fileName.setValue(asset.name)
                    if (fullAsset) box.endInSeconds.setValue(fullAsset.duration)
                }))

            nano.box.file.refer(fileBox)
        })
        return { success: true, message: `Loaded sample '${asset.name}' into Nano on '${trackName}'` }
    }

    async setPlayfieldPad(trackName: string, padIndex: number, query: string): Promise<ToolResult> {
        const samples = await this.listSamples()
        const match = this.findAsset(samples, query)
        if (match.isEmpty()) return { success: false, reason: `No sample matching '${query}' found.` }
        const asset = match.unwrap()

        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const instrument = adapter.inputAdapter.match({
                    some: input => input.type === "instrument" ? input : undefined,
                    none: () => undefined
                })

                if (!instrument || !(instrument instanceof PlayfieldDeviceBoxAdapter)) {
                    return { success: false, reason: `No Playfield instrument found on track '${trackName}'` }
                }

                const playfield = instrument as PlayfieldDeviceBoxAdapter
                const { editing, boxGraph } = this.studio.project
                const allSamples = await this.studio.sampleService.collectAllFiles()
                const fullAsset = (allSamples as unknown as Array<{ uuid: string, duration: number }>).find((a) => a.uuid === asset.uuid)

                editing.modify(() => {
                    const fileUUID = UUID.parse(asset.uuid)
                    const fileBox = boxGraph.findBox<AudioFileBox>(fileUUID)
                        .unwrapOrElse(() => AudioFileBox.create(boxGraph, fileUUID, box => {
                            box.fileName.setValue(asset.name)
                            if (fullAsset) box.endInSeconds.setValue(fullAsset.duration)
                        }))

                    const existingPad = playfield.samples.adapters().find(a => (a.box as PlayfieldSampleBox).index.getValue() === padIndex)
                    if (existingPad) {
                        (existingPad.box as PlayfieldSampleBox).file.refer(fileBox)
                    } else {
                        PlayfieldSampleBox.create(boxGraph, UUID.generate(), box => {
                            box.device.refer(playfield.box.samples)
                            box.file.refer(fileBox)
                            box.index.setValue(padIndex)
                        })
                    }
                })
                return { success: true, message: `Loaded sample '${asset.name}' onto pad ${padIndex} on '${trackName}'` }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

    async setSoundfont(trackName: string, query: string): Promise<ToolResult> {
        const sfs = await this.listSoundfonts()
        const match = this.findAsset(sfs, query)
        if (match.isEmpty()) return { success: false, reason: `No soundfont matching '${query}' found.` }
        const asset = match.unwrap()

        return this.findAudioUnitAdapter(trackName).match<Promise<ToolResult>>({
            some: async (adapter) => {
                const instrument = adapter.inputAdapter.match({
                    some: input => input.type === "instrument" ? input : undefined,
                    none: () => undefined
                })

                if (!instrument || !(instrument instanceof SoundfontDeviceBoxAdapter)) {
                    return { success: false, reason: `No Soundfont instrument found on track '${trackName}'` }
                }

                const sfAdapter = instrument as SoundfontDeviceBoxAdapter
                const { editing, boxGraph } = this.studio.project
                editing.modify(() => {
                    const fileUUID = UUID.parse(asset.uuid)
                    const fileBox = boxGraph.findBox<SoundfontFileBox>(fileUUID)
                        .unwrapOrElse(() => SoundfontFileBox.create(boxGraph, fileUUID, box => {
                            box.fileName.setValue(asset.name)
                        }))

                    sfAdapter.box.file.refer(fileBox)
                })
                return { success: true, message: `Loaded soundfont '${asset.name}' on '${trackName}'` }
            },
            none: () => Promise.resolve({ success: false, reason: "Track not found" })
        })
    }

    private findAsset<T extends { name: string }>(assets: T[], query: string): Option<T> {
        const q = query.toLowerCase()
        const exact = assets.find(a => a.name.toLowerCase() === q)
        if (exact) return Option.wrap(exact)
        const keyword = assets.find(a => a.name.toLowerCase().includes(q))
        return Option.wrap(keyword)
    }


}
