import css from "./Mixer.sass?inline"
import {isDefined, Lifecycle, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {TourAnchors} from "@/ui/tour/TourAnchors"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {AudioUnitBoxAdapter, AudioUnitGroups, Devices} from "@opendaw/studio-adapters"
import {ChannelStrip} from "@/ui/mixer/ChannelStrip.tsx"
import {Vertex} from "@opendaw/lib-box"
import {Orientation, Scroller} from "@/ui/components/Scroller.tsx"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {installAutoScroll} from "@/ui/AutoScroll"
import {deferNextFrame, Events, Html} from "@opendaw/lib-dom"
import {AudioUnitsClipboard, ClipboardManager} from "@opendaw/studio-core"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {installTrackSelection} from "@/ui/timeline/tracks/audio-unit/TrackGrouping"
import {GroupRails} from "@/ui/timeline/tracks/audio-unit/GroupRails"
import {WheelScaling} from "@/ui/timeline/WheelScaling"

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
        <div className={className} data-group-surface="mixer">
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
    const anchorLifecycle = lifecycle.own(new Terminator())
    const groupRails = lifecycle.own(new GroupRails(project, channelStripContainer, true, unit => {
        audioUnits.opt(unit.address.uuid).ifSome(({editor}) => {
            scrollModel.position += editor.getBoundingClientRect().left - channelStripWrapper.getBoundingClientRect().left
        })
    }))
    const updateDom = deferNextFrame(() => {
        channelStripContainer.appendChild(headers)
        const order = new Map(AudioUnitGroups.ordered(project.rootBox).map((unit, index) => [unit, index]))
        const sorted = audioUnits.values().filter(({adapter}) => !AudioUnitGroups.hidden(adapter.box))
            .toSorted((left, right) => (order.get(left.adapter.box) ?? -1) - (order.get(right.adapter.box) ?? -1))
        const visible = new Set(sorted.map(({editor}) => editor))
        audioUnits.values().forEach(({editor}) => {if (!visible.has(editor)) {editor.remove()}})
        sorted.forEach(({editor}, index) => {
            if (editor instanceof HTMLElement) {editor.style.gridColumn = String(index + 2)}
            channelStripContainer.appendChild(editor)
        })
        groupRails.update(sorted.map(({adapter}) => adapter.box))
        anchorLifecycle.terminate()
        const first = sorted.at(0)
        if (isDefined(first)) {TourAnchors.register(anchorLifecycle, first.editor, "mixer")}
        updateScroller()
    })
    const removeEditingIndicator = () => channelStripContainer
        .querySelectorAll(".editing")
        .forEach(({classList}) => classList.remove("editing"))
    let scrollIntoViewEnabled: boolean = true
    const {editing, boxGraph, rootBoxAdapter, userEditingManager, boxAdapters} = project
    lifecycle.ownAll(
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
        project.rootBoxAdapter.audioUnits.catchupAndSubscribe({
            onAdd: (adapter: AudioUnitBoxAdapter) => {
                const terminator = lifecycle.spawn()
                const editor: HTMLElement = <ChannelStrip lifecycle={terminator} service={service} adapter={adapter}
                                                          compact={false}/>
                editor.dataset.unit = UUID.toString(adapter.uuid)
                installTrackSelection(terminator, project, editor, adapter.box, () => {})
                terminator.ownAll(
                    adapter.box.groupParent.subscribe(() => updateDom.request()),
                    adapter.box.groupCollapsed.subscribe(() => updateDom.request()),
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
        project.trackSelection.value.subscribe(() => {
            audioUnits.values().forEach(({adapter, editor}) => editor.classList.toggle("editing", project.trackSelection.has(adapter.box)))
        }),
        project.userEditingManager.audioUnit.catchupAndSubscribe(optVertex => optVertex.match({
            none: removeEditingIndicator,
            some: (vertex: Vertex) => {
                removeEditingIndicator()
                const uuid = project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().uuid
                audioUnits.opt(uuid).ifSome(({editor}) => {
                    audioUnits.values().forEach(({adapter, editor}) => editor.classList.toggle("editing", project.trackSelection.hasExplicitSelection
                        ? project.trackSelection.has(adapter.box) : UUID.equals(adapter.uuid, uuid)))
                    if (scrollIntoViewEnabled) {
                        editor.scrollIntoView({behavior: "smooth", inline: "center"})
                    }
                })
            }
        })),
        Html.watchResize(element, updateScroller),
        Events.subscribe(headers, "pointerdown", () => project.userEditingManager.audioUnit.clear()),
        Events.subscribe(element, "wheel", (event: WheelEvent) => {
            if (event.altKey) {
                event.preventDefault()
                event.stopPropagation()
                scrollModel.position += WheelScaling.pixelsOf(event)
                return
            }
            scrollModel.position += event.deltaX
        }, {passive: false}),
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
        installAutoScroll(channelStripWrapper, (deltaX, _deltaY) => scrollModel.position += deltaX, {padding: [0, 32, 0, 0]})
    )
    return element
}