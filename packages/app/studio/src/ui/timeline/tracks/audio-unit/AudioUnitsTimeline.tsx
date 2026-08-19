import css from "./AudioUnitsTimeline.sass?inline"
import {clamp, DefaultObservableValue, int, isDefined, Lifecycle, Option, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Scroller} from "@/ui/components/Scroller.tsx"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {TrackFactory, TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {Track} from "./Track"
import {ModulatorTrack} from "./ModulatorTrack"
import {RegionsArea} from "./regions/RegionsArea.tsx"
import {ClipsArea} from "./clips/ClipsArea.tsx"
import {
    AudioUnitBoxAdapter,
    InstrumentFactories,
    ModulatorBoxAdapter,
    TrackBoxAdapter
} from "@opendaw/studio-adapters"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {ExtraSpace} from "./Constants.ts"
import {HeadersArea} from "@/ui/timeline/tracks/audio-unit/headers/HeadersArea"
import {Icon} from "@/ui/components/Icon"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MenuButton} from "@/ui/components/MenuButton"
import {AudioUnitsClipboard, ClipboardManager, MenuItem} from "@opendaw/studio-core"
import {DefaultInstrumentFactory} from "@/ui/defaults/DefaultInstrumentFactory"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {IndexedBox} from "@opendaw/lib-box"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {installAutoScroll} from "@/ui/AutoScroll"

const className = Html.adoptStyleSheet(css, "AudioUnitsTimeline")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const AudioUnitsTimeline = ({lifecycle, service}: Construct) => {
    const {range} = service.timeline
    const {editing, boxGraph, rootBoxAdapter, userEditingManager, boxAdapters} = service.project
    const scrollModel = new ScrollModel()
    const scrollContainer: HTMLElement = (
        <div className="scrollable">
            <div className="fill"/>
            <div className="extra">
                <div className="create-instrument">
                    <MenuButton root={MenuItem.root()
                        .setRuntimeChildrenProcedure(parent => parent
                            .addMenuItem(...Object.entries(InstrumentFactories.Named).map(([_key, factory]) =>
                                MenuItem.default({
                                    label: factory.defaultName,
                                    icon: factory.defaultIcon
                                }).setTriggerProcedure(() => {
                                    const {project: {api, editing}} = service
                                    editing.modify(() => DefaultInstrumentFactory.create(api, factory))
                                }))))}
                                appearance={{color: Colors.shadow}}>
                        <span>Add instrument</span> <Icon symbol={IconSymbol.Add}/>
                    </MenuButton>
                </div>
                <div className="region-area help-section">Drop instruments or samples here</div>
            </div>
        </div>
    )
    const factory: TrackFactory = {
        create: (manager: TracksManager,
                 lifecycle: Lifecycle,
                 audioUnitBoxAdapter: AudioUnitBoxAdapter,
                 trackBoxAdapter: TrackBoxAdapter,
                 unitHead: DefaultObservableValue<boolean>): HTMLElement => (
            <Track lifecycle={lifecycle}
                   service={service}
                   trackManager={manager}
                   audioUnitBoxAdapter={audioUnitBoxAdapter}
                   trackBoxAdapter={trackBoxAdapter}
                   unitHead={unitHead}/>
        ),
        createModulator: (manager: TracksManager,
                          lifecycle: Lifecycle,
                          _modulator: ModulatorBoxAdapter,
                          trackBoxAdapter: TrackBoxAdapter): HTMLElement => (
            <ModulatorTrack lifecycle={lifecycle}
                            service={service}
                            trackManager={manager}
                            trackBoxAdapter={trackBoxAdapter}/>
        )
    }
    const manager: TracksManager = lifecycle.own(new TracksManager(service, scrollContainer, factory))
    const insertLine: HTMLElement = <div className="unit-insert-line"/>
    // The insert slot among a device group's lanes for a pointer y: before the first lane whose vertical
    // center lies below it, else after the last.
    const trackInsertSlot = (members: ReadonlyArray<{element: HTMLElement}>, clientY: number): int => {
        const before = members.findIndex(({element: lane}) => {
            const rect = lane.getBoundingClientRect()
            return clientY < (rect.top + rect.bottom) / 2
        })
        return before === -1 ? members.length : before
    }
    const element: HTMLElement = (
        <div className={className}>
            <HeadersArea lifecycle={lifecycle}
                         service={service}
                         manager={manager}
                         scrollModel={scrollModel}/>
            <ClipsArea lifecycle={lifecycle}
                       service={service}
                       manager={manager}
                       scrollModel={scrollModel}
                       scrollContainer={scrollContainer}/>
            <RegionsArea lifecycle={lifecycle}
                         service={service}
                         manager={manager}
                         scrollModel={scrollModel}
                         scrollContainer={scrollContainer}
                         range={range}/>
            {scrollContainer}
            <Scroller lifecycle={lifecycle} model={scrollModel} floating/>
        </div>
    )
    lifecycle.ownAll(
        DragAndDrop.installTarget(scrollContainer, {
            drag: (event: DragEvent, dragData: AnyDragData): boolean => {
                if (dragData.type === "track") {
                    const members = manager.groupMembers(UUID.parse(dragData.uuid))
                    if (members.length < 2) {return false}
                    const position = members.findIndex(({trackBoxAdapter}) =>
                        UUID.toString(trackBoxAdapter.uuid) === dragData.uuid)
                    const slot = trackInsertSlot(members, event.clientY)
                    if (slot !== position && slot !== position + 1) {
                        const componentRect = element.getBoundingClientRect()
                        const anchorY = slot < members.length
                            ? members[slot].element.getBoundingClientRect().top
                            : members[members.length - 1].element.getBoundingClientRect().bottom
                        insertLine.style.top = `${anchorY - componentRect.top - 1}px`
                        if (!insertLine.isConnected) {element.appendChild(insertLine)}
                    } else if (insertLine.isConnected) {
                        insertLine.remove()
                    }
                    return true
                }
                if (dragData.type !== "channelstrip") {return false}
                const optAdapter = boxGraph.findBox(UUID.parse(dragData.uuid))
                    .map(box => boxAdapters.adapterFor(box, AudioUnitBoxAdapter))
                if (optAdapter.isEmpty()) {return false}
                const limit = optAdapter.unwrap().indicesLimit()
                const [index, successor] = DragAndDrop.findInsertLocationVertical(event, scrollContainer, limit)
                const delta = index - dragData.start_index
                if (delta < 0 || delta > 1) {
                    // The line is anchored to the component (the scrollable must stay position-static: an
                    // absolutely positioned child would inflate its scrollHeight and re-parent div.fill).
                    const componentRect = element.getBoundingClientRect()
                    const anchorY = isDefined(successor)
                        ? successor.getBoundingClientRect().top
                        : Array.from(scrollContainer.querySelectorAll("[data-drag]"))
                            .reduce((bottom, unit) => Math.max(bottom, unit.getBoundingClientRect().bottom),
                                scrollContainer.getBoundingClientRect().top)
                    insertLine.style.top = `${anchorY - componentRect.top - 1}px`
                    if (!insertLine.isConnected) {element.appendChild(insertLine)}
                } else if (insertLine.isConnected) {
                    insertLine.remove()
                }
                return true
            },
            drop: (event: DragEvent, dragData: AnyDragData) => {
                if (insertLine.isConnected) {insertLine.remove()}
                if (dragData.type === "track") {
                    const members = manager.groupMembers(UUID.parse(dragData.uuid))
                    if (members.length < 2) {return}
                    const position = members.findIndex(({trackBoxAdapter}) =>
                        UUID.toString(trackBoxAdapter.uuid) === dragData.uuid)
                    const slot = trackInsertSlot(members, event.clientY)
                    if (slot === position || slot === position + 1) {return}
                    // Permute only the GROUP members' own index values, so every other track keeps its index.
                    const indexValues = members.map(({trackBoxAdapter}) => trackBoxAdapter.indexField.getValue())
                    const reordered = members.toSpliced(position, 1)
                    reordered.splice(slot > position ? slot - 1 : slot, 0, members[position])
                    editing.modify(() => reordered.forEach(({trackBoxAdapter}, order) =>
                        trackBoxAdapter.indexField.setValue(indexValues[order])))
                    return
                }
                if (dragData.type !== "channelstrip") {return}
                const optAdapter = boxGraph.findBox(UUID.parse(dragData.uuid))
                    .map(box => boxAdapters.adapterFor(box, AudioUnitBoxAdapter))
                const [min, max] = optAdapter.unwrap("optAdapter").indicesLimit()
                if (min === max) {return}
                const [index] = DragAndDrop.findInsertLocationVertical(event, scrollContainer)
                const delta = clamp(index, min, max) - dragData.start_index
                if (delta < 0 || delta > 1) { // zero or one has no effect on the order
                    editing.modify(() =>
                        IndexedBox.moveIndex(service.project.rootBox.audioUnits, dragData.start_index, delta))
                }
            },
            enter: () => {},
            leave: () => {
                if (insertLine.isConnected) {insertLine.remove()}
            }
        }),
        ClipboardManager.install(element, AudioUnitsClipboard.createHandler({
            getEnabled: () => true,
            editing,
            boxGraph,
            rootBoxAdapter,
            audioUnitEditing: userEditingManager.audioUnit,
            getEditedAudioUnit: () => userEditingManager.audioUnit.get().flatMap(vertex => {
                if (vertex.box.name === AudioUnitBox.ClassName) {
                    return Option.wrap(boxAdapters.adapterFor(vertex.box as AudioUnitBox, AudioUnitBoxAdapter))
                }
                return Option.None
            })
        })),
        AnimationFrame.add(() => {
            // The ResizeObserver only tracks the visible size changes, not off-screen content,
            // so we take a simple approach to catch all changes.
            scrollModel.visibleSize = scrollContainer.clientHeight
            scrollModel.contentSize = scrollContainer.scrollHeight
        }),
        scrollModel.subscribe(({contentSize}) => {
            element.style.setProperty("--rest-top", `${contentSize === 0 ? 0 : contentSize}px`)
            element.style.setProperty("--rest-height", `${element.clientHeight - contentSize}px`)
        }),
        Events.subscribe(element, "wheel", (event: WheelEvent) => scrollModel.position += event.deltaY, {passive: false}),
        scrollModel.subscribe(() => scrollContainer.scrollTop = scrollModel.position),
        Events.subscribe(scrollContainer, "scroll", () => scrollModel.position = scrollContainer.scrollTop),
        installAutoScroll(scrollContainer, (_deltaX, deltaY) => scrollModel.position += deltaY, {padding: [24, 0, 24, 0]})
    )
    element.style.setProperty("--extra-space", `${ExtraSpace}px`)
    return element
}