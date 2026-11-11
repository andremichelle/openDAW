import css from "./CompositeCellEditor.sass?inline"
import {Errors, Lifecycle, Option, panic} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Box, Vertex} from "@opendaw/lib-box"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {TextScroller} from "@/ui/TextScroller"
import {Surface} from "@/ui/surface/Surface"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {CompositeCell, DeviceHost, InstrumentCompositeCellBoxAdapter} from "@opendaw/studio-adapters"
import {MidiKeys} from "@opendaw/lib-dsp"
import {Icon} from "@/ui/components/Icon"
import {CompositeCellStrip} from "@/ui/devices/CompositeCellStrip"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {MenuButton} from "@/ui/components/MenuButton"
import {ClipboardManager, DevicesClipboard, MenuItem} from "@opendaw/studio-core"
import {MenuItems} from "@/ui/devices/menu-items"
import {DebugMenus} from "@/ui/menu/debug"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "CompositeCellEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    host: DeviceHost
}

export const CompositeCellEditor = ({lifecycle, service, host}: Construct) => {
    const {editing, userEditingManager, deviceSelection} = service.project
    const backTarget: Vertex<Pointers> = MenuItems.backTargetOfCell(host)
    const cell: Option<CompositeCell> = host.asCompositeCell()
    const isLayer = cell.mapOr(entry => entry.cellKind === "instrument", false)
    const noun = isLayer ? "layer" : "entry"
    const name: HTMLElement = (
        <h1 onInit={element => {
            lifecycle.ownAll(
                TextScroller.install(element),
                Events.subscribeDblDwn(element, async event => {
                    if (cell.isEmpty()) {return}
                    const {labelField} = cell.unwrap().compositeDevice()
                    const {status, error, value} = await Promises.tryCatch(Surface.get(element)
                        .requestFloatingTextInput(event, labelField.getValue()))
                    if (status === "rejected") {
                        if (!Errors.isAbort(error)) {return panic(error)}
                    } else {
                        editing.modify(() => labelField.setValue(value))
                    }
                })
            )
        }}/>
    )
    const menu: HTMLElement = (
        <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => {
            cell.match({
                none: () => MenuItems.forAudioUnitInput(parent, service, host),
                some: entry => MenuItems.forCompositeCell(parent, host, entry.compositeDevice())
            })
            parent.addMenuItem(DebugMenus.debugBox(cell.mapOr<Box>(entry => entry.box, host.audioUnitBoxAdapter().box)))
        })} style={{minWidth: "0", fontSize: "0.75em", marginLeft: "auto"}}
                    appearance={{color: Colors.cream, activeColor: Colors.bright}}>
            <Icon symbol={IconSymbol.Menu}/>
        </MenuButton>
    )
    const header: HTMLElement = (<h1 className="header" tabIndex={0}>{name}{menu}</h1>)
    const backButton: HTMLElement = (
        <div className="back-button">
            <Icon symbol={IconSymbol.RoundUp}/>
        </div>
    )
    const controls: HTMLElement = cell.match({
        none: () => <div/>,
        some: entry => (
            <div className="controls">
                <CompositeCellStrip lifecycle={lifecycle} project={service.project} cell={entry} noun={noun}/>
            </div>
        )
    })
    const isPad = cell.mapOr(entry => entry instanceof InstrumentCompositeCellBoxAdapter && entry.isPad, false)
    const numbers: HTMLElement = <div className="entry-numbers"/>
    const previousPad: HTMLElement = <div className="step-button"><Icon symbol={IconSymbol.ArrowLeft}/></div>
    const nextPad: HTMLElement = <div className="step-button"><Icon symbol={IconSymbol.ArrowRight}/></div>
    const padKey: HTMLElement = <div className="pad-key"/>
    const padStepper: HTMLElement = <div className="pad-stepper">{previousPad}{padKey}{nextPad}</div>
    const navigation: HTMLElement = (
        <div className="navigation">
            {backButton}
            {isPad ? padStepper : numbers}
        </div>
    )
    const element: HTMLElement = (
        <div className={Html.buildClassList(className, isLayer && "instrument")}>
            {header}{controls}{navigation}
        </div>
    )
    lifecycle.ownAll(
        TextTooltip.default(backButton, () => "Back to the parent chain"),
        Events.subscribe(backButton, "click", () => userEditingManager.audioUnit.edit(backTarget)),
        Events.subscribe(name, "pointerdown", () => {
            deviceSelection.deselectAll()
            header.classList.add("selected")
            header.focus()
        }),
        deviceSelection.catchupAndSubscribe({
            onSelected: () => header.classList.remove("selected"),
            onDeselected: () => {}
        }),
        // a paste into the focused header lands at the start of this chain
        ClipboardManager.install(header, DevicesClipboard.createHandler({
            getEnabled: () => true,
            editing,
            selection: deviceSelection,
            boxGraph: service.project.boxGraph,
            boxAdapters: service.project.boxAdapters,
            getHost: (): Option<DeviceHost> => Option.wrap(host)
        }))
    )
    cell.match({
        none: () => {name.textContent = host.label},
        some: entry => {
            const rebuildNumbers = (siblings: ReadonlyArray<CompositeCell>) => {
                Html.empty(numbers)
                siblings.forEach(sibling => numbers.appendChild((
                    <div className={Html.buildClassList("entry-number", sibling === entry && "current")}
                         onclick={() => {
                             if (sibling !== entry) {userEditingManager.audioUnit.edit(sibling.box)}
                         }}>{String(sibling.indexField.getValue() + 1)}</div>
                )))
            }
            const neighbour = (siblings: ReadonlyArray<CompositeCell>, direction: -1 | 1): Option<CompositeCell> => {
                const key = entry.indexField.getValue()
                const others = siblings.filter(sibling => sibling !== entry
                    && Math.sign(sibling.indexField.getValue() - key) === direction)
                    .sort((left, right) => direction * (left.indexField.getValue() - right.indexField.getValue()))
                return Option.wrap(others.at(0))
            }
            const updateStepper = (siblings: ReadonlyArray<CompositeCell>) => {
                padKey.textContent = MidiKeys.toFullString(entry.indexField.getValue())
                previousPad.classList.toggle("disabled", neighbour(siblings, -1).isEmpty())
                nextPad.classList.toggle("disabled", neighbour(siblings, 1).isEmpty())
            }
            const step = (direction: -1 | 1) => neighbour(entry.siblings(), direction)
                .ifSome(sibling => userEditingManager.audioUnit.edit(sibling.box))
            const update = (siblings: ReadonlyArray<CompositeCell>) => {
                if (!entry.box.isAttached()) {return}
                if (isPad) {updateStepper(siblings)} else {rebuildNumbers(siblings)}
            }
            update(entry.siblings())
            lifecycle.ownAll(
                entry.subscribeSiblings(update),
                entry.indexField.subscribe(() => update(entry.siblings())),
                Events.subscribe(previousPad, "click", () => step(-1)),
                Events.subscribe(nextPad, "click", () => step(1)),
                TextTooltip.default(previousPad, () => "Previous pad"),
                TextTooltip.default(nextPad, () => "Next pad"),
                entry.compositeDevice().labelField.catchupAndSubscribe(owner => name.textContent = owner.getValue())
            )
        }
    })
    return element
}
