import css from "./TubularAudition.sass?inline"
import {byte, DefaultObservableValue, Errors, Exec, int, isDefined, Procedure, RuntimeNotifier, tryCatch, unitValue, UUID} from "@opendaw/lib-std"
import {Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {PPQN} from "@opendaw/lib-dsp"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Box} from "@opendaw/lib-box"
import {DeviceBoxUtils, PresetEncoder, TubularDeviceBoxAdapter, TubularPreset} from "@opendaw/studio-adapters"
import {InstrumentPresetMeta, PresetStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs"
import {DialogHandler} from "@/ui/components/Dialog"
import {AccessKey} from "@/opendaw-api/AccessKey"
import {OpenPresetAPI} from "@/opendaw-api/OpenPresetAPI"
import {TubularCartridge} from "./TubularCartridges"

const className = Html.adoptStyleSheet(css, "TubularAudition")

type Construct = {
    service: StudioService
    adapter: TubularDeviceBoxAdapter
    cartridges: ReadonlyArray<TubularCartridge>
    applyVoice: (cartridge: TubularCartridge, index: int) => void
    start: {bank: int, index: int}
}

// Cursor over every bundled voice: arrows step, space plays a phrase, K keeps. Keepers persist in
// localStorage and become openDAW presets (local, optionally uploaded as stock) on request.
export namespace TubularAudition {
    const STORAGE_KEY = "tubular-audition-keepers"
    const PHRASE: ReadonlyArray<byte> = [48, 55, 60, 64]

    const keeperKey = (cartridge: TubularCartridge, index: int): string => `${cartridge.file}#${index}`

    const loadKeepers = (): Set<string> => {
        const stored = tryCatch(() => localStorage.getItem(STORAGE_KEY))
        if (stored.status === "failure" || !isDefined(stored.value)) {return new Set()}
        const parsed = tryCatch(() => JSON.parse(stored.value as string) as ReadonlyArray<string>)
        return parsed.status === "success" && Array.isArray(parsed.value) ? new Set(parsed.value) : new Set()
    }

    const storeKeepers = (keepers: ReadonlySet<string>): void => {
        tryCatch(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keepers))))
    }

    export const open = async ({service, adapter, cartridges, applyVoice, start}: Construct): Promise<void> => {
        const {project} = service
        const {editing, engine} = project
        const keepers = loadKeepers()
        let bank = start.bank
        let index = start.index
        const audioUnitBox = adapter.audioUnitBoxAdapter().box
        const audition = (): void => {
            const uuid = audioUnitBox.address.uuid
            PHRASE.forEach((pitch, step) => setTimeout(() =>
                engine.noteSignal({type: "note-audition", uuid, pitch, duration: PPQN.Quarter, velocity: 0.8}), step * 110))
            setTimeout(() => PHRASE.forEach(pitch =>
                engine.noteSignal({type: "note-audition", uuid, pitch: pitch + 12, duration: PPQN.Bar, velocity: 0.7})), 600)
        }
        const status: HTMLElement = <div className="status"/>
        const list: HTMLElement = <ol className="voices"/>
        const select = (nextBank: int, nextIndex: int, play: boolean): void => {
            bank = (nextBank + cartridges.length) % cartridges.length
            index = (nextIndex + 32) % 32
            applyVoice(cartridges[bank], index)
            render()
            if (play) {audition()}
        }
        const toggleKeeper = (): void => {
            const key = keeperKey(cartridges[bank], index)
            if (keepers.has(key)) {keepers.delete(key)} else {keepers.add(key)}
            storeKeepers(keepers)
            render()
        }
        const render = (): void => {
            const cartridge = cartridges[bank]
            status.textContent = `${cartridge.name}  (${bank + 1}/${cartridges.length})  ·  keepers: ${keepers.size}`
            replaceChildren(list, ...cartridge.voices.map((voice, voiceIndex) => {
                const key = keeperKey(cartridge, voiceIndex)
                const classes = Html.buildClassList("voice", voiceIndex === index && "current", keepers.has(key) && "keeper")
                return (
                    <li className={classes} onclick={() => select(bank, voiceIndex, true)}>
                        <span className="index">{String(voiceIndex + 1).padStart(2, "0")}</span>
                        <span className="name">{voice.name}</span>
                        <span className="star" onclick={(event: MouseEvent) => {
                            event.stopPropagation()
                            select(bank, voiceIndex, false)
                            toggleKeeper()
                        }}>{keepers.has(key) ? "★" : "☆"}</span>
                    </li>
                )
            }))
            list.querySelector(".current")?.scrollIntoView({block: "nearest"})
        }
        const onKey = (event: KeyboardEvent): void => {
            switch (event.code) {
                case "ArrowRight": select(bank, index + 1, true); break
                case "ArrowLeft": select(bank, index - 1, true); break
                case "ArrowDown": select(bank + 1, 0, true); break
                case "ArrowUp": select(bank - 1, 0, true); break
                case "Space": audition(); break
                case "KeyK": toggleKeeper(); break
                default: return
            }
            event.preventDefault()
            event.stopPropagation()
        }
        const content: HTMLElement = (
            <div className={className} tabIndex={0} onkeydown={onKey}>
                {status}
                {list}
                <div className="help">← → voice · ↑ ↓ bank · space play · K keep · click a row to play, the star to keep</div>
            </div>
        )
        const keeperEntries = (): ReadonlyArray<{cartridge: TubularCartridge, index: int}> => cartridges.flatMap(cartridge =>
            cartridge.voices.map((_, voiceIndex) => ({cartridge, index: voiceIndex}))
                .filter(({cartridge, index}) => keepers.has(keeperKey(cartridge, index))))
        // Every keeper becomes an instrument preset: the voice is written into THIS device, the unit is encoded
        // without its effect chain, and the current voice is restored afterwards.
        const savePresets = async (upload: boolean): Promise<void> => {
            const entries = keeperEntries()
            if (entries.length === 0) {
                RuntimeNotifier.notify({message: "No keepers marked.", icon: "Warning"})
                return
            }
            const restore = TubularPreset.read(adapter.box)
            const restoreLoad = adapter.box.voiceLoad.getValue()
            const progressValue = new DefaultObservableValue<unitValue>(0.0)
            const progress = RuntimeNotifier.progress({headline: upload ? "Uploading presets" : "Saving presets", progress: progressValue})
            let count = 0
            for (const {cartridge, index} of entries) {
                const voice = cartridge.voices[index]
                editing.modify(() => TubularPreset.apply(adapter.box, voice.data), false)
                const bytes = PresetEncoder.encode(audioUnitBox, {
                    excludeEffect: (box: Box) => DeviceBoxUtils.isChainEffectOf(box, audioUnitBox)
                })
                const now = Date.now()
                const meta: InstrumentPresetMeta = {
                    category: "instrument",
                    uuid: UUID.toString(UUID.generate()),
                    name: voice.name,
                    device: "Tubular",
                    description: `${cartridge.name} #${index + 1} · ${cartridge.author} · ${cartridge.license}`,
                    created: now,
                    modified: now
                }
                const result = await Promises.tryCatch(upload
                    ? OpenPresetAPI.get().upload(bytes as ArrayBuffer, meta)
                    : PresetStorage.save(meta, bytes))
                if (result.status === "rejected") {
                    console.warn(result.error)
                    RuntimeNotifier.notify({message: `Failed at ${voice.name}: ${result.error}`, icon: "Warning"})
                    break
                }
                count++
                progressValue.setValue(count / entries.length)
            }
            editing.modify(() => {
                TubularPreset.apply(adapter.box, restore)
                adapter.box.voiceLoad.setValue(restoreLoad + 1)
            }, false)
            progress.terminate()
            RuntimeNotifier.notify({message: `${count} preset(s) ${upload ? "uploaded" : "saved"}.`, icon: "Checkbox"})
        }
        const exportList = async (): Promise<void> => {
            const json = JSON.stringify(keeperEntries().map(({cartridge, index}) =>
                ({file: cartridge.file, index, name: cartridge.voices[index].name})), null, 2)
            const result = await Promises.tryCatch(Files.save(new TextEncoder().encode(json).buffer as ArrayBuffer, {
                suggestedName: "tubular-keepers.json",
                types: [{description: "JSON", accept: {"application/json": [".json"]}}]
            }))
            if (result.status === "rejected" && !Errors.isAbort(result.error)) {console.warn(result.error)}
        }
        const guard = (procedure: Exec): Procedure<DialogHandler> => () => {
            procedure()
            content.focus()
        }
        select(bank, index, false)
        setTimeout(() => content.focus(), 0)
        const dialog = Promises.tryCatch(Dialogs.show({
            headline: "Audition Cartridges",
            content,
            okText: "Close",
            growWidth: true,
            buttons: [
                {text: "Export list", onClick: guard(() => {exportList().catch(console.warn)})},
                {text: "Save keepers as presets", onClick: guard(() => {savePresets(false).catch(console.warn)})},
                ...(AccessKey.get().nonEmpty()
                    ? [{text: "Upload keepers as stock", onClick: guard(() => {savePresets(true).catch(console.warn)})}]
                    : [])
            ]
        }))
        const result = await dialog
        if (result.status === "rejected" && !Errors.isAbort(result.error)) {console.warn(result.error)}
    }
}
