import css from "./TubularAudition.sass?inline"
import {
    byte, DefaultObservableValue, Errors, Exec, int, isDefined, Procedure, RuntimeNotifier, tryCatch, unitValue, UUID
} from "@opendaw/lib-std"
import {Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {PPQN} from "@opendaw/lib-dsp"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Box} from "@opendaw/lib-box"
import {DeviceBoxUtils, Dx7Sysex, PresetEncoder, TubularDeviceBoxAdapter, TubularPreset} from "@opendaw/studio-adapters"
import {InstrumentPresetMeta, MenuItem, PresetStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs"
import {DialogHandler} from "@/ui/components/Dialog"
import {MenuButton} from "@/ui/components/MenuButton"
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

// Cursor over every voice of the bundled banks and any .syx loaded here: a bank menu, arrows step, space
// plays a phrase, K keeps. Keepers persist in localStorage and become openDAW presets (local, optionally
// uploaded as stock) on request.
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
        const banks: Array<TubularCartridge> = [...cartridges]
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
        const bankLabel: HTMLElement = <span/>
        const status: HTMLElement = <span className="status"/>
        const list: HTMLElement = <ol className="voices"/>
        const select = (nextBank: int, nextIndex: int, play: boolean): void => {
            bank = (nextBank + banks.length) % banks.length
            const count = banks[bank].voices.length
            index = (nextIndex + count) % count
            applyVoice(banks[bank], index)
            render()
            if (play) {audition()}
        }
        const toggleKeeper = (): void => {
            const key = keeperKey(banks[bank], index)
            if (keepers.has(key)) {keepers.delete(key)} else {keepers.add(key)}
            storeKeepers(keepers)
            render()
        }
        const loadFile = async (): Promise<void> => {
            const opened = await Promises.tryCatch(Files.open({
                types: [{description: "DX7 SysEx", accept: {"application/octet-stream": [".syx"]}}]
            }))
            if (opened.status === "rejected") {return}
            const [file] = opened.value
            const bytes = new Uint8Array(await file.arrayBuffer())
            const decoded = tryCatch(() => Dx7Sysex.decode(bytes))
            if (decoded.status === "failure") {
                RuntimeNotifier.notify({message: `Not a DX7 dump: ${file.name}`, icon: "Warning"})
                return
            }
            const name = file.name.replace(/\.syx$/i, "")
            banks.push({name, file: file.name, author: name, license: "loaded from file", source: "", voices: decoded.value})
            select(banks.length - 1, 0, true)
        }
        const render = (): void => {
            const cartridge = banks[bank]
            bankLabel.textContent = cartridge.name
            status.textContent = `${bank + 1} / ${banks.length}  ·  keepers: ${keepers.size}`
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
        const bankMenu = (parent: MenuItem): void => {
            parent.addMenuItem(...banks.map((cartridge, bankIndex) => MenuItem.default({label: cartridge.name, checked: bankIndex === bank})
                .setTriggerProcedure(() => {
                    select(bankIndex, 0, true)
                    content.focus()
                })))
            parent.addMenuItem(MenuItem.default({label: "Load DX7 .syx…", separatorBefore: true})
                .setTriggerProcedure(() => {loadFile().catch(console.warn).finally(() => content.focus())}))
        }
        const content: HTMLElement = (
            <div className={className} tabIndex={0} onkeydown={onKey}>
                <div className="bank">
                    <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(bankMenu)}>
                        {bankLabel}
                    </MenuButton>
                    {status}
                </div>
                {list}
                <div className="help">← → voice · ↑ ↓ bank · space play · K keep · click a row to play, the star to keep</div>
            </div>
        )
        const keeperEntries = (): ReadonlyArray<{cartridge: TubularCartridge, index: int}> => banks.flatMap(cartridge =>
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
                    uuid: UUID.toString(await UUID.sha256(voice.data.slice().buffer)),
                    name: voice.name,
                    device: "Tubular",
                    description: cartridge.credit ?? "",
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
                keepers.delete(keeperKey(cartridge, index))
                count++
                progressValue.setValue(count / entries.length)
            }
            storeKeepers(keepers)
            editing.modify(() => {
                TubularPreset.apply(adapter.box, restore)
                adapter.box.voiceLoad.setValue(restoreLoad + 1)
            }, false)
            progress.terminate()
            render()
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
        const result = await Promises.tryCatch(Dialogs.show({
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
        if (result.status === "rejected" && !Errors.isAbort(result.error)) {console.warn(result.error)}
    }
}
