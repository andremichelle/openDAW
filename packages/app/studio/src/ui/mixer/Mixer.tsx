import css from "./Mixer.sass?inline"
import {clamp, Lifecycle, Terminable, Terminator, UUID} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {AudioUnitBoxAdapter, Devices} from "@moises-ai/studio-adapters"
import {ChannelStrip} from "@/ui/mixer/ChannelStrip.tsx"
import {IndexedBox, Vertex} from "@moises-ai/lib-box"
import {Orientation, Scroller} from "@/ui/components/Scroller.tsx"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {installAutoScroll} from "@/ui/AutoScroll"
import {InsertMarker} from "@/ui/components/InsertMarker"
import {deferNextFrame, Events, Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "mixer")

type AudioUnitEntry = {
    adapter: AudioUnitBoxAdapter
    terminator: Terminator
    editor: Element
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const Mixer = ({lifecycle, service}: Construct) => {
    const project = service.project
    const headers: HTMLElement = (
        <div className="headers">
            <h5/>
            <h5>Input</h5>
            <h5>Sends</h5>
            <h5>Output</h5>
            <h5>Pan</h5>
            <h5>Volume</h5>
            <h5>Exclude</h5>
        </div>
    )
    const channelStripContainer: HTMLElement = (
        <div className="channel-strips">
            {headers}
        </div>
    )
    const channelStripWrapper: HTMLElement = (
        <div className="channel-strips-wrapper">
            {channelStripContainer}
        </div>
    )
    const scrollModel = new ScrollModel()
    const element: HTMLElement = (
        <div className={className}>
            {/*<TimelineNavigation lifecycle={lifecycle} service={service} />*/}
            {channelStripWrapper}
            <Scroller lifecycle={lifecycle} model={scrollModel} orientation={Orientation.horizontal} floating/>
        </div>
    )
    const updateScroller = (): void => {
        const visibleSize = element.clientWidth
        const contentSize = channelStripContainer.clientWidth
        scrollModel.visibleSize = visibleSize
        scrollModel.contentSize = contentSize
    }
    const audioUnits = UUID.newSet<AudioUnitEntry>(entry => entry.adapter.uuid)
    const updateDom = deferNextFrame(() => {
        Html.empty(channelStripContainer)
        channelStripContainer.appendChild(headers)
        audioUnits.values()
            .toSorted((a, b) => a.adapter.indexField.getValue() - b.adapter.indexField.getValue())
            .forEach(({editor}) => channelStripContainer.appendChild(editor))
        updateScroller()
    })
    const removeEditingIndicator = () => channelStripContainer
        .querySelectorAll(".editing")
        .forEach(({classList}) => classList.remove("editing"))
    const insertMarker: HTMLElement = <InsertMarker/>
    let scrollIntoViewEnabled: boolean = true
    lifecycle.ownAll(
        project.rootBoxAdapter.audioUnits.catchupAndSubscribe({
            onAdd: (adapter: AudioUnitBoxAdapter) => {
                const terminator = lifecycle.spawn()
                const editor: HTMLElement = <ChannelStrip lifecycle={terminator} service={service} adapter={adapter}
                                                          compact={false}/>
                terminator.ownAll(
                    Events.subscribe(editor, "pointerdown", () => {
                        scrollIntoViewEnabled = false
                        if (!project.userEditingManager.audioUnit.isEditing(adapter.box.editing)) {
                            project.userEditingManager.audioUnit.edit(adapter.box.editing)
                        }
                    }),
                    Events.subscribe(editor, "pointerup", () => scrollIntoViewEnabled = true)
                )
                audioUnits.add({adapter, terminator, editor})
                updateDom.request()
            },
            onRemove: (adapter: AudioUnitBoxAdapter) => {
                const {editor, terminator} = audioUnits.removeByKey(adapter.uuid)
                terminator.terminate()
                editor.remove()
                updateDom.request()
            },
            onReorder: (_adapter: AudioUnitBoxAdapter) => updateDom.request()
        }),
        project.userEditingManager.audioUnit.catchupAndSubscribe(optVertex => optVertex.match({
            none: removeEditingIndicator,
            some: (vertex: Vertex) => {
                removeEditingIndicator()
                const uuid = project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().uuid
                audioUnits.opt(uuid).ifSome(({editor}) => {
                    editor.classList.add("editing")
                    if (scrollIntoViewEnabled) {
                        editor.scrollIntoView({behavior: "smooth", inline: "center"})
                    }
                })
            }
        })),
        Html.watchResize(element, updateScroller),
        Events.subscribe(headers, "pointerdown", () => project.userEditingManager.audioUnit.clear()),
        Events.subscribe(element, "wheel", (event: WheelEvent) => scrollModel.position += event.deltaX, {passive: false}),
        (() => {
            let ignore = false
            return Terminable.many(
                scrollModel.subscribe(() => {
                    if (ignore) {return}
                    channelStripWrapper.scrollLeft = scrollModel.position
                }),
                Events.subscribe(channelStripWrapper, "scroll", () => {
                    ignore = true
                    scrollModel.position = channelStripWrapper.scrollLeft
                    ignore = false
                }, {capture: true, passive: false})
            )
        })(),
        DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, dragData: AnyDragData): boolean => {
                const {type} = dragData
                if (type !== "channelstrip") {return false}
                const optAdapter = project.boxGraph.findBox(UUID.parse(dragData.uuid))
                    .map(box => project.boxAdapters.adapterFor(box, AudioUnitBoxAdapter))
                if (optAdapter.isEmpty()) {return false}
                const limit = optAdapter.unwrap().indicesLimit()
                const [index, successor] = DragAndDrop.findInsertLocation(event, element, limit)
                const delta = index - dragData.start_index
                if (delta < 0 || delta > 1) {
                    if (insertMarker.nextSibling !== successor) {
                        channelStripContainer.insertBefore(insertMarker, successor)
                    }
                } else if (insertMarker.isConnected) {
                    insertMarker.remove()
                }
                return true
            },
            drop: (event: DragEvent, dragData: AnyDragData) => {
                if (insertMarker.isConnected) {insertMarker.remove()}
                const {type} = dragData
                if (type !== "channelstrip") {return}
                const optAdapter = project.boxGraph.findBox(UUID.parse(dragData.uuid))
                    .map(box => project.boxAdapters.adapterFor(box, AudioUnitBoxAdapter))
                const [min, max] = optAdapter.unwrap().indicesLimit()
                if (min === max) {return}
                const [index] = DragAndDrop.findInsertLocation(event, element)
                const delta = clamp(index, min, max) - dragData.start_index
                if (delta < 0 || delta > 1) { // if delta is zero or one, it has no effect on the order
                    service.project.editing.modify(() =>
                        IndexedBox.moveIndex(project.rootBox.audioUnits, dragData.start_index, delta))
                }
            },
            enter: () => {},
            leave: () => {
                if (insertMarker.isConnected) {insertMarker.remove()}
            }
        }),
        installAutoScroll(channelStripWrapper, (deltaX, _deltaY) => scrollModel.position += deltaX, {padding: [0, 32, 0, 0]})
    )
    return element
}