import css from "./MIDIMappingPanel.sass?inline"
import {
    DefaultObservableValue,
    int,
    isDefined,
    Lifecycle,
    Option,
    RuntimeNotifier,
    SortedSet,
    StringMapping,
    Terminator
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Address, Int32Field} from "@opendaw/lib-box"
import {IconSymbol} from "@opendaw/studio-enums"
import {MIDIControllerBox} from "@opendaw/studio-boxes"
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
import {Icon} from "@/ui/components/Icon.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"

const className = Html.adoptStyleSheet(css, "MIDIMappingPanel")

const TakeoverLabels: Readonly<Record<MIDITakeover, string>> = {
    [MIDITakeover.Jump]: "Jump",
    [MIDITakeover.Pickup]: "Pickup",
    [MIDITakeover.Scaling]: "Scaling"
}

const EncodingLabels: Readonly<Record<MIDIEncoding, string>> = {
    [MIDIEncoding.Absolute]: "Absolute",
    [MIDIEncoding.TwosComplement]: "Relative (2's compl.)",
    [MIDIEncoding.BinaryOffset]: "Relative (offset 64)",
    [MIDIEncoding.SignBit]: "Relative (sign bit)"
}

type SortColumn = "port" | "cc" | "track" | "device" | "parameter"

type Row = {
    box: MIDIControllerBox
    port: string
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
    const {editing, midiLearning, userEditingManager, parameterFieldAdapters} = project
    const search = new DefaultObservableValue<string>("")
    const sortColumn = new DefaultObservableValue<SortColumn>("track")
    const ascending = new DefaultObservableValue<boolean>(true)
    const selection: SortedSet<Address, MIDIControllerBox> = Address.newSet<MIDIControllerBox>(box => box.address)
    const rowsLifecycle = lifecycle.own(new Terminator())
    const body: HTMLElement = <div className="rows"/>
    const targetLabel: HTMLElement = <span className="target-label"/>
    const updateTargetLabel = () => targetLabel.textContent = midiLearning.mapMode.getValue()
        ? midiLearning.mapTarget
            .flatMap(field => parameterFieldAdapters.opt(field.address))
            .mapOr(adapter => `Target: ${adapter.name}. Move a controller to assign it.`,
                "Click a control to select a target")
        : "Turn on Map Mode in the header to assign controls"
    const nothingSelected = new DefaultObservableValue<boolean>(true)
    const deleteButton: HTMLElement = (
        <Button lifecycle={lifecycle}
                appearance={{framed: true, tooltip: "Delete selected mappings"}}
                disabled={nothingSelected}
                onClick={() => {
                    const boxes = [...selection.values()]
                    selection.clear()
                    editing.modify(() => boxes.forEach(box => box.delete()))
                }}>
            <Icon symbol={IconSymbol.Delete}/><span>Delete selected</span>
        </Button>)
    let visibleBoxes: ReadonlyArray<MIDIControllerBox> = []
    const selectAll: HTMLInputElement = (
        <input type="checkbox"
               title="Select all visible mappings"
               oninput={() => {
                   visibleBoxes.forEach(box => selectAll.checked ? selection.add(box) : selection.removeByKey(box.address))
                   render()
               }}/>)
    const updateSelectionState = () => {
        const selectedVisible = visibleBoxes.filter(box => selection.hasKey(box.address)).length
        nothingSelected.setValue(selection.size() === 0)
        selectAll.checked = visibleBoxes.length > 0 && selectedVisible === visibleBoxes.length
        selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleBoxes.length
    }
    const projectName = (): string => {
        const name = service.projectProfileService.getValue()
            .mapOr(profile => profile.meta.name.trim().replace(/[\\/:*?"<>|]/g, "-"), "")
        return name.length > 0 ? name : "midi-mappings"
    }
    const exportPreset = async () => {
        const text = JSON.stringify(MIDIMappingPreset.create(project), null, 2)
        await Promises.tryCatch(Files.save(new TextEncoder().encode(text).buffer, {
            suggestedName: `${projectName()}.json`,
            types: [FilePickerAcceptTypes.JsonFileType]
        }))
    }
    const importPreset = async () => {
        const opened = await Promises.tryCatch(Files.open({types: [FilePickerAcceptTypes.JsonFileType]}))
        if (opened.status === "rejected") {return}
        const file = opened.value.at(0)
        if (!isDefined(file)) {return}
        await MIDIMappingPreset.parse(await file.text()).match({
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
    const portName = (box: MIDIControllerBox): string => {
        const deviceId = box.deviceId.getValue()
        const port = deviceId === ""
            ? "Any"
            : MidiDevices.inputDevices().find(input => input.id === deviceId)?.name ?? deviceId
        const channel = box.deviceChannel.getValue()
        return `${port} / ${channel < 0 ? "All" : channel + 1}`
    }
    const toRow = (box: MIDIControllerBox): Row => {
        const vertex = box.parameter.targetVertex
        const unit = vertex.flatMap(target => ParameterOwner.audioUnitOf(project, target))
        const parameter = box.parameter.targetAddress.flatMap(address => parameterFieldAdapters.opt(address))
        return {
            box,
            port: portName(box),
            cc: box.controlId.getValue(),
            track: unit.mapOr(adapter => adapter.label, ""),
            device: vertex.flatMap(target => ParameterOwner.nameOf(project, target)).unwrapOrElse(""),
            parameterName: parameter.mapOr(adapter => adapter.name, "Unknown"),
            unit,
            parameter
        }
    }
    const sortKey = (row: Row, column: SortColumn): string => {
        switch (column) {
            case "port":
                return row.port
            case "cc":
                return String(row.cc).padStart(3, "0")
            case "track":
                return row.track
            case "device":
                return row.device
            case "parameter":
                return row.parameterName
        }
    }
    const compare = (a: Row, b: Row): int => {
        const column = sortColumn.getValue()
        const order = sortKey(a, column).localeCompare(sortKey(b, column))
        return ascending.getValue() ? order : -order
    }
    const matches = (row: Row): boolean => {
        const query = search.getValue().trim().toLowerCase()
        if (query.length === 0) {return true}
        return [row.port, String(row.cc), row.track, row.device, row.parameterName]
            .some(text => text.toLowerCase().includes(query))
    }
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
    const choiceMenu = <T extends int>(labels: Readonly<Record<T, string>>, field: Int32Field) =>
        MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
            ...Object.entries<string>(labels).map(([key, label]) => MenuItem.default({
                label,
                checked: field.getValue() === Number(key)
            }).setTriggerProcedure(() => editing.modify(() => field.setValue(Number(key)))))))
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
                No MIDI mappings yet. Turn on Map Mode in the header, click a control and move a knob on your controller.
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
            const takeoverLabel: HTMLElement = <span/>
            const encodingLabel: HTMLElement = <span/>
            rowsLifecycle.ownAll(
                box.takeover.catchupAndSubscribe(owner =>
                    takeoverLabel.textContent = TakeoverLabels[owner.getValue() as MIDITakeover] ?? "?"),
                box.encoding.catchupAndSubscribe(owner =>
                    encodingLabel.textContent = EncodingLabels[owner.getValue() as MIDIEncoding] ?? "?")
            )
            body.append(
                <div className="row">
                    <input type="checkbox"
                           checked={selection.hasKey(box.address)}
                           oninput={(event: Event) => {
                               if (!(event.target instanceof HTMLInputElement)) {return}
                               if (event.target.checked) {selection.add(box)} else {selection.removeByKey(box.address)}
                               updateSelectionState()
                           }}/>
                    <span className="port">{row.port}</span>
                    <span className="cc">{String(row.cc)}</span>
                    <span className="link" onInit={element =>
                        rowsLifecycle.own(Events.subscribe(element, "click", locate))}>{row.track}</span>
                    <span className="link" onInit={element => rowsLifecycle.own(Events.subscribe(element, "click", locate))}>
                        {row.device}
                    </span>
                    <span className="parameter">{row.parameterName}</span>
                    <NumberInput lifecycle={rowsLifecycle}
                                 model={EditWrapper.forValue(editing, box.min)}
                                 mapper={valueMapper(parameter)}
                                 maxChars={6}
                                 step={0.01}
                                 decimal={true}/>
                    <NumberInput lifecycle={rowsLifecycle}
                                 model={EditWrapper.forValue(editing, box.max)}
                                 mapper={valueMapper(parameter)}
                                 maxChars={6}
                                 step={0.01}
                                 decimal={true}/>
                    <MenuButton root={choiceMenu(TakeoverLabels, box.takeover)} appearance={{framed: true}}>
                        {takeoverLabel}
                    </MenuButton>
                    <MenuButton root={choiceMenu(EncodingLabels, box.encoding)} appearance={{framed: true}}>
                        {encodingLabel}
                    </MenuButton>
                    <Button lifecycle={rowsLifecycle}
                            appearance={{tooltip: "Delete mapping"}}
                            onClick={() => editing.modify(() => box.delete())}>
                        <Icon symbol={IconSymbol.Delete}/>
                    </Button>
                </div>)
        })
    }
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
        midiLearning.subscribeChanges(render),
        search.subscribe(render),
        sortColumn.subscribe(render),
        ascending.subscribe(render),
        midiLearning.mapMode.subscribe(updateTargetLabel),
        midiLearning.mapTarget.subscribe(updateTargetLabel)
    )
    updateTargetLabel()
    render()
    return (
        <div className={className}>
            <div className="toolbar">
                {targetLabel}
                <SearchInput lifecycle={lifecycle} model={search} placeholder="Search mappings"/>
                <Button lifecycle={lifecycle}
                        appearance={{framed: true, tooltip: "Export mappings as JSON"}}
                        onClick={() => exportPreset().then()}>
                    <span>Export</span>
                </Button>
                <Button lifecycle={lifecycle}
                        appearance={{framed: true, tooltip: "Import mappings from JSON"}}
                        onClick={() => importPreset().then()}>
                    <span>Import</span>
                </Button>
                {deleteButton}
            </div>
            <div className="table">
                <div className="header">
                    <span>{selectAll}</span>
                    {header("Port / Ch", "port")}
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
