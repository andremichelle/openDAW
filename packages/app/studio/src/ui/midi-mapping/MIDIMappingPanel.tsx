import css from "./MIDIMappingPanel.sass?inline"
import {
    Arrays,
    DefaultObservableValue,
    Errors,
    int,
    isDefined,
    Lifecycle,
    Option,
    Optional,
    RuntimeNotifier,
    SortedSet,
    StringMapping,
    Terminable,
    Terminator,
    ValueGuard
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {deferNextFrame, Events, Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Address, Float32Field, Int32Field} from "@opendaw/lib-box"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AudioUnitBox, MIDIControllerBox} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, AutomatableParameterFieldAdapter, ParameterOwner} from "@opendaw/studio-adapters"
import {
    FilePickerAcceptTypes,
    MenuItem,
    MidiDevices,
    MIDIEncoding,
    MIDIMappingPreset,
    MIDITakeover
} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {SearchInput} from "@/ui/components/SearchInput.tsx"
import {NumberInput} from "@/ui/components/NumberInput.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {EditorHeader} from "@/ui/code-editor/EditorHeader"
import {ScrollFade} from "@/ui/components/ScrollFade"

const className = Html.adoptStyleSheet(css, "MIDIMappingPanel")

type Choice<T extends int> = readonly [T, string]

const TakeoverChoices: ReadonlyArray<Choice<MIDITakeover>> = [
    [MIDITakeover.Jump, "Jump"], [MIDITakeover.Pickup, "Pickup"], [MIDITakeover.Scaling, "Scaling"]
]

const EncodingChoices: ReadonlyArray<Choice<MIDIEncoding>> = [
    [MIDIEncoding.Absolute, "Absolute"],
    [MIDIEncoding.TwosComplement, "Relative (2's compl.)"],
    [MIDIEncoding.BinaryOffset, "Relative (offset 64)"],
    [MIDIEncoding.SignBit, "Relative (sign bit)"]
]

const ValueStep = 0.01

const labelOf = <T extends int>(choices: ReadonlyArray<Choice<T>>, value: int): string =>
    Option.wrap(choices.find(([choice]) => choice === value)).mapOr(([, label]) => label, "")

type SortColumn = "midi-device" | "cc" | "track" | "device" | "parameter"

const SortColumns: ReadonlyArray<SortColumn> = ["track", "device", "parameter", "cc", "midi-device"]

type Row = {
    box: MIDIControllerBox
    midiDevice: string
    cc: int
    track: string
    device: string
    parameterName: string
    unit: Option<AudioUnitBoxAdapter>
    parameter: Option<AutomatableParameterFieldAdapter>
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MIDIMappingPanel = ({lifecycle, service}: Construct): HTMLElement => {
    const {project} = service
    const {editing, midiLearning, userEditingManager, parameterFieldAdapters, boxGraph} = project
    const search = new DefaultObservableValue<string>("")
    const sortColumn = new DefaultObservableValue<SortColumn>("track")
    const ascending = new DefaultObservableValue<boolean>(true)
    const selection: SortedSet<Address, MIDIControllerBox> = Address.newSet<MIDIControllerBox>(box => box.address)
    const nothingSelected = new DefaultObservableValue<boolean>(true)
    const allSelected = new DefaultObservableValue<boolean>(false)
    const rowsLifecycle = lifecycle.own(new Terminator())
    const body: HTMLElement = <div className="rows" onInit={element => ScrollFade.install(lifecycle, element)}/>
    const targetLabel: HTMLElement = <span className="target-label"/>
    let visibleBoxes: ReadonlyArray<MIDIControllerBox> = []
    let syncingSelection = false
    const updateTargetLabel = () => targetLabel.textContent = midiLearning.mapTarget
        .flatMap(field => parameterFieldAdapters.opt(field.address))
        .mapOr(adapter => `${adapter.name}: move a knob or fader on your MIDI device`, "Click a parameter to map it")
    const updateSelectionState = () => {
        syncingSelection = true
        nothingSelected.setValue(selection.size() === 0)
        allSelected.setValue(visibleBoxes.length > 0 && visibleBoxes.every(box => selection.hasKey(box.address)))
        syncingSelection = false
    }
    const projectName = (): string => {
        const name = service.projectProfileService.getValue()
            .mapOr(profile => profile.meta.name.trim().replace(/[\\/:*?"<>|]/g, "-"), "")
        return name.length > 0 ? name : "midi-mappings"
    }
    const reportFailure = async (headline: string, error: unknown): Promise<void> => {
        if (Errors.isAbort(error)) {return}
        await RuntimeNotifier.info({headline, message: error instanceof Error ? error.message : String(error)})
    }
    const exportPreset = async () => {
        const text = JSON.stringify(MIDIMappingPreset.create(project), null, 2)
        const result = await Promises.tryCatch(Files.save(new TextEncoder().encode(text).buffer, {
            suggestedName: `${projectName()}.json`,
            types: [FilePickerAcceptTypes.JsonFileType]
        }))
        if (result.status === "rejected") {await reportFailure("Export MIDI Mappings", result.error)}
    }
    const importPreset = async () => {
        const opened = await Promises.tryCatch(Files.open({types: [FilePickerAcceptTypes.JsonFileType]}))
        if (opened.status === "rejected") {return reportFailure("Import MIDI Mappings", opened.error)}
        const file = opened.value.at(0)
        if (!isDefined(file)) {return}
        const read = await Promises.tryCatch(file.text())
        if (read.status === "rejected") {return reportFailure("Import MIDI Mappings", read.error)}
        await MIDIMappingPreset.parse(read.value).match({
            none: () => RuntimeNotifier.info({
                headline: "Import MIDI Mappings",
                message: "The file is not a valid MIDI mapping preset."
            }),
            some: preset => {
                const {imported, replaced, skipped} = MIDIMappingPreset.apply(project, preset)
                return RuntimeNotifier.info({
                    headline: "Import MIDI Mappings",
                    message: `Imported ${imported}, replaced ${replaced}, skipped ${skipped}.`
                })
            }
        })
    }
    const midiDeviceName = (box: MIDIControllerBox): string => {
        const deviceId = box.filterDeviceId.getValue()
        if (deviceId === "") {return "All devices"}
        return Option.wrap(MidiDevices.inputDevices().find(input => input.id === deviceId))
            .mapOr(input => input.name ?? deviceId, "Unavailable device")
    }
    const midiDeviceLabel = (box: MIDIControllerBox): string => {
        const channel = box.deviceChannel.getValue()
        return `${midiDeviceName(box)} / ${channel < 0 ? "All channels" : `Channel ${channel + 1}`}`
    }
    const midiDeviceMenu = (box: MIDIControllerBox): MenuItem => MenuItem.root().setRuntimeChildrenProcedure(parent => {
        const isCurrent = (deviceId: Option<string>): boolean =>
            box.filterDeviceId.getValue() === deviceId.unwrapOrElse("")
        const assign = (deviceId: Option<string>, channel: int) => editing.modify(() => {
            box.filterDeviceId.setValue(deviceId.unwrapOrElse(""))
            box.deviceChannel.setValue(channel)
        })
        const channelItem = (deviceId: Option<string>, channel: int, label: string) =>
            MenuItem.default({label, checked: isCurrent(deviceId) && box.deviceChannel.getValue() === channel})
                .setTriggerProcedure(() => assign(deviceId, channel))
        const deviceItem = (label: string, deviceId: Option<string>, separatorBefore: boolean) =>
            MenuItem.default({label, checked: isCurrent(deviceId), separatorBefore})
                .setRuntimeChildrenProcedure(channels => channels.addMenuItem(
                    channelItem(deviceId, -1, "All channels"),
                    ...Arrays.create(channel => channelItem(deviceId, channel, `Channel ${channel + 1}`), 16)))
        parent.addMenuItem(
            deviceItem("All devices", Option.None, false),
            ...MidiDevices.externalInputDevices().unwrapOrElse(Arrays.empty())
                .map((input, index) => deviceItem(input.name ?? "Unknown", Option.wrap(input.id), index === 0)))
    })
    const toRow = (box: MIDIControllerBox): Row => {
        const vertex = box.parameter.targetVertex
        const unit = vertex.flatMap(target => ParameterOwner.audioUnitOf(project, target))
        const parameter = box.parameter.targetAddress.flatMap(address => parameterFieldAdapters.opt(address))
        return {
            box,
            midiDevice: midiDeviceLabel(box),
            cc: box.controlId.getValue(),
            track: unit.mapOr(adapter => adapter.label, ""),
            device: vertex.flatMap(target => target.box instanceof AudioUnitBox
                ? Option.wrap("Channelstrip") : ParameterOwner.nameOf(project, target)).unwrapOrElse(""),
            parameterName: parameter.mapOr(adapter => adapter.name, "Unknown"),
            unit,
            parameter
        }
    }
    const sortKey = (row: Row, column: SortColumn): string => {
        switch (column) {
            case "midi-device":
                return row.midiDevice
            case "cc":
                return String(row.cc)
            case "track":
                return row.track
            case "device":
                return row.device
            case "parameter":
                return row.parameterName
        }
    }
    const compare = (a: Row, b: Row): int => {
        const order = [sortColumn.getValue(), ...SortColumns]
            .map(column => sortKey(a, column).localeCompare(sortKey(b, column), undefined, {numeric: true}))
            .find(result => result !== 0) ?? 0
        return ascending.getValue() ? order : -order
    }
    const matches = (row: Row): boolean => {
        const query = search.getValue().trim().toLowerCase()
        if (query.length === 0) {return true}
        return [row.midiDevice, String(row.cc), row.track, row.device, row.parameterName]
            .some(text => text.toLowerCase().includes(query))
    }
    const wholeValueGuard = (parameter: Option<AutomatableParameterFieldAdapter>,
                             field: Float32Field): Optional<ValueGuard<number>> =>
        parameter.mapOr<Optional<ValueGuard<number>>>(({valueMapping}) => valueMapping.floating() ? undefined : {
            guard: (unit: number): number => {
                const current = valueMapping.y(field.getValue())
                const base = valueMapping.x(current)
                const delta = unit - base
                if (Math.abs(Math.abs(delta) - ValueStep) > 1e-9) {return valueMapping.x(valueMapping.y(unit))}
                const probeStep = Math.sign(delta) / 4096
                for (let probe = base + probeStep; probe >= 0.0 && probe <= 1.0; probe += probeStep) {
                    const value = valueMapping.y(probe)
                    if (value !== current) {return valueMapping.x(value)}
                }
                return base
            }
        }, undefined)
    const valueMapper = (parameter: Option<AutomatableParameterFieldAdapter>): StringMapping<number> =>
        parameter.match<StringMapping<number>>({
            none: () => StringMapping.percent({fractionDigits: 0}),
            some: adapter => ({
                x: (unit: number) => adapter.stringMapping.x(adapter.valueMapping.y(unit)),
                y: (text: string) => {
                    const result = adapter.stringMapping.y(text)
                    return result.type === "explicit"
                        ? {type: "explicit", value: adapter.valueMapping.x(result.value)}
                        : result
                }
            })
        })
    const choiceMenu = <T extends int>(choices: ReadonlyArray<Choice<T>>, field: Int32Field) =>
        MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(...choices.map(([value, label]) =>
            MenuItem.default({label, checked: field.getValue() === value})
                .setTriggerProcedure(() => editing.modify(() => field.setValue(value))))))
    const dropdown = (root: MenuItem, text: HTMLElement, centered: boolean = false): HTMLElement => (
        <div className={Html.buildClassList("dropdown", centered && "centered")}>
            <MenuButton root={root} appearance={{framed: true, color: Colors.gray, activeColor: Colors.bright}}>
                <label>{text}</label>
            </MenuButton>
        </div>
    )
    const render = () => {
        rowsLifecycle.terminate()
        Html.empty(body)
        const boxes = midiLearning.controllerBoxes()
        selection.values().filter(box => !boxes.includes(box)).forEach(box => selection.removeByKey(box.address))
        const rows = boxes.map(toRow).filter(matches).sort(compare)
        visibleBoxes = rows.map(({box}) => box)
        updateSelectionState()
        if (boxes.length === 0) {
            body.append(<div className="placeholder">
                No MIDI mappings yet. Click a parameter and move a knob or fader on your MIDI device.
            </div>)
            return
        }
        if (rows.length === 0) {
            body.append(<div className="placeholder">No mapping matches the search.</div>)
            return
        }
        rows.forEach(row => {
            const {box, unit, parameter} = row
            const locate = () => unit.ifSome(adapter => userEditingManager.audioUnit.edit(adapter.box.editing))
            const selected = new DefaultObservableValue<boolean>(selection.hasKey(box.address))
            const takeoverLabel: HTMLElement = <span/>
            const encodingLabel: HTMLElement = <span/>
            const takeoverCell: HTMLElement = dropdown(choiceMenu(TakeoverChoices, box.takeover), takeoverLabel, true)
            rowsLifecycle.ownAll(
                selected.subscribe(owner => {
                    if (owner.getValue()) {selection.add(box)} else {selection.removeByKeyIfExist(box.address)}
                    updateSelectionState()
                }),
                box.takeover.catchupAndSubscribe(owner =>
                    takeoverLabel.textContent = labelOf(TakeoverChoices, owner.getValue())),
                box.encoding.catchupAndSubscribe(owner => {
                    encodingLabel.textContent = labelOf(EncodingChoices, owner.getValue())
                    takeoverCell.classList.toggle("disabled", owner.getValue() !== MIDIEncoding.Absolute)
                }),
                box.controlId.subscribe(() => renderRequest.request()),
                box.deviceChannel.subscribe(() => renderRequest.request()),
                box.filterDeviceId.subscribe(() => renderRequest.request())
            )
            body.append(
                <div className="row">
                    <Checkbox lifecycle={rowsLifecycle} model={selected}
                              appearance={{framed: true, color: Colors.black, cursor: "pointer"}}>
                        <Icon symbol={IconSymbol.Checkbox}/>
                    </Checkbox>
                    {dropdown(midiDeviceMenu(box), <span>{row.midiDevice}</span>)}
                    <span className="cc">{String(row.cc)}</span>
                    <span className="link" onInit={element =>
                        rowsLifecycle.own(Events.subscribe(element, "click", locate))}>{row.track}</span>
                    <span className="link" onInit={element =>
                        rowsLifecycle.own(Events.subscribe(element, "click", locate))}>{row.device}</span>
                    <span className="parameter">{row.parameterName}</span>
                    <NumberInput lifecycle={rowsLifecycle}
                                 className="value"
                                 model={EditWrapper.forValue(editing, box.min)}
                                 mapper={valueMapper(parameter)}
                                 guard={wholeValueGuard(parameter, box.min)}
                                 maxChars={6}
                                 step={ValueStep}
                                 decimal={true}/>
                    <NumberInput lifecycle={rowsLifecycle}
                                 className="value"
                                 model={EditWrapper.forValue(editing, box.max)}
                                 mapper={valueMapper(parameter)}
                                 guard={wholeValueGuard(parameter, box.max)}
                                 maxChars={6}
                                 step={ValueStep}
                                 decimal={true}/>
                    {takeoverCell}
                    {dropdown(choiceMenu(EncodingChoices, box.encoding), encodingLabel)}
                    <Button lifecycle={rowsLifecycle}
                            className="delete"
                            appearance={{tooltip: "Delete mapping", cursor: "pointer", color: Colors.dark}}
                            onClick={() => editing.modify(() => box.delete())}>
                        <Icon symbol={IconSymbol.Delete}/>
                    </Button>
                </div>)
        })
    }
    const renderRequest = lifecycle.own(deferNextFrame(render))
    const header = (label: string, column: SortColumn): HTMLElement => (
        <span className="sortable" onInit={element => lifecycle.ownAll(
            Events.subscribe(element, "click", () => {
                if (sortColumn.getValue() === column) {
                    ascending.setValue(!ascending.getValue())
                } else {
                    sortColumn.setValue(column)
                    ascending.setValue(true)
                }
            }),
            sortColumn.catchupAndSubscribe(owner => element.classList.toggle("sorted", owner.getValue() === column)),
            ascending.catchupAndSubscribe(owner => element.classList.toggle("descending", !owner.getValue()))
        )}>{label}</span>)
    lifecycle.ownAll(
        allSelected.subscribe(owner => {
            if (syncingSelection) {return}
            visibleBoxes.forEach(box => owner.getValue()
                ? selection.add(box) : selection.removeByKeyIfExist(box.address))
            render()
        }),
        midiLearning.subscribeChanges(() => renderRequest.request()),
        search.subscribe(() => renderRequest.request()),
        sortColumn.subscribe(() => renderRequest.request()),
        ascending.subscribe(() => renderRequest.request()),
        boxGraph.subscribeToAllUpdates({
            onUpdate: update => {
                if (update.type === "primitive" && typeof update.newValue === "string") {renderRequest.request()}
            }
        }),
        midiLearning.mapTarget.catchupAndSubscribe(updateTargetLabel),
        Terminable.create(() => midiLearning.mapMode.setValue(false))
    )
    midiLearning.mapMode.setValue(true)
    render()
    return (
        <div className={className}>
            <EditorHeader lifecycle={lifecycle} onClose={() => service.closeCodeEditor()} closeTooltip="Close MIDI Mapping">
                {targetLabel}
                <SearchInput lifecycle={lifecycle} model={search} placeholder="Search mappings"/>
                <Button lifecycle={lifecycle}
                        appearance={{framed: true, tooltip: "Export mappings as JSON", cursor: "pointer"}}
                        onClick={() => exportPreset().finally()}>
                    <span>Export</span>
                </Button>
                <Button lifecycle={lifecycle}
                        appearance={{framed: true, tooltip: "Import mappings from JSON", cursor: "pointer"}}
                        onClick={() => importPreset().finally()}>
                    <span>Import</span>
                </Button>
                <Button lifecycle={lifecycle}
                        appearance={{framed: true, tooltip: "Delete selected mappings", cursor: "pointer"}}
                        disabled={nothingSelected}
                        onClick={() => {
                            const boxes = [...selection.values()]
                            selection.clear()
                            editing.modify(() => boxes.forEach(box => box.delete()))
                        }}>
                    <Icon symbol={IconSymbol.Delete}/><span>Delete selected</span>
                </Button>
            </EditorHeader>
            <div className="table">
                <div className="header">
                    <span>
                        <Checkbox lifecycle={lifecycle} model={allSelected}
                                  appearance={{
                                      framed: true, color: Colors.black, cursor: "pointer",
                                      tooltip: "Select all visible mappings"
                                  }}>
                            <Icon symbol={IconSymbol.Checkbox}/>
                        </Checkbox>
                    </span>
                    {header("MIDI Device", "midi-device")}
                    {header("CC", "cc")}
                    {header("Track", "track")}
                    {header("Device", "device")}
                    {header("Parameter", "parameter")}
                    <span>Min</span>
                    <span>Max</span>
                    <span>Takeover</span>
                    <span>Encoding</span>
                    <span/>
                </div>
                {body}
            </div>
        </div>
    )
}
