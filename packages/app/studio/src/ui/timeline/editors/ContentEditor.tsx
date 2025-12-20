import css from "./ContentEditor.sass?inline"
import {Lifecycle, Option, Terminator, ValueMapping} from "@opendaw/lib-std"
import {createElement, Frag, replaceChildren} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {
    AudioClipBox,
    AudioRegionBox,
    BoxVisitor,
    NoteClipBox,
    NoteRegionBox,
    ValueClipBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {NoteEditor} from "@/ui/timeline/editors/notes/NoteEditor.tsx"
import {
    AudioClipBoxAdapter,
    AudioRegionBoxAdapter,
    NoteClipBoxAdapter,
    NoteRegionBoxAdapter,
    ValueClipBoxAdapter,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"
import {Box, PointerField, Vertex} from "@opendaw/lib-box"
import {SnapSelector} from "@/ui/timeline/SnapSelector.tsx"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {TimelineRange} from "@opendaw/studio-core"
import {TimeAxis} from "@/ui/timeline/TimeAxis.tsx"
import {TimelineRangeSlider} from "@/ui/timeline/TimelineRangeSlider.tsx"
import {ValueEventsEditor} from "./value/ValueEventsEditor.tsx"
import {FlexSpacer} from "@/ui/components/FlexSpacer.tsx"
import {PPQN} from "@opendaw/lib-dsp"
import {AudioEditor} from "@/ui/timeline/editors/audio/AudioEditor.tsx"
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@/ui/model/menu-item.ts"
import {EditorMenuCollector} from "@/ui/timeline/editors/EditorMenuCollector.ts"

import {ClipReader} from "@/ui/timeline/editors/ClipReader.ts"
import {RegionBound} from "./RegionBound"
import {
    AudioEventOwnerReader,
    EventOwnerReader,
    NoteEventOwnerReader,
    ValueEventOwnerReader
} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {RegionReader} from "@/ui/timeline/editors/RegionReader.ts"
import {Colors, Pointers} from "@opendaw/studio-enums"
import {ParameterValueEditing} from "@/ui/timeline/editors/value/ValueEditingContext.ts"
import {AnimationFrame, deferNextFrame, Events, Html, Keyboard} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "ContentEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ContentEditor = ({lifecycle, service}: Construct) => {
    const range = new TimelineRange({padding: 12})
    range.minimum = PPQN.SemiQuaver * 2
    const snapping = new Snapping(range)
    const runtime = lifecycle.own(new Terminator())
    const editingSubject = service.project.userEditingManager.timeline
    const contentEditor = <div className="editor"/>
    const menu: EditorMenuCollector = {
        viewMenu: MenuItem.root(),
        editMenu: MenuItem.root()
    }
    let owner: Option<EventOwnerReader<unknown>> = Option.None
    lifecycle.ownAll(
        {terminate: () => {owner = Option.None}},
        service.project.timelineBoxAdapter.catchupAndSubscribeSignature(signature => snapping.signature = signature),
        menu.viewMenu.attach(collector => collector.addItems(
            MenuItem.default({label: "Zoom to Edit-Region", selectable: editingSubject.get().nonEmpty()})
                .setTriggerProcedure(() => owner
                    .ifSome(reader => range.zoomRange(reader.offset, reader.offset + reader.loopDuration + PPQN.Bar, 16))),
            MenuItem.default({label: "Exit", selectable: editingSubject.get().nonEmpty()})
                .setTriggerProcedure(() => editingSubject.clear())
        ))
    )
    const element: HTMLElement = (
        <div className={className} tabIndex={-1}>
            <div className="generic">
                <div className="tool">
                    <SnapSelector lifecycle={lifecycle} snapping={snapping}/>
                    <FlexSpacer/>
                    <div className="menu">
                        <MenuButton root={menu.viewMenu}
                                    appearance={{color: Colors.gray, activeColor: Colors.bright}}
                                    groupId="content-editor">
                            <span style={{padding: "0 0.5em"}}>View</span>
                        </MenuButton>
                        <MenuButton root={menu.editMenu}
                                    appearance={{color: Colors.gray, activeColor: Colors.bright}}
                                    groupId="content-editor">
                            <span style={{padding: "0 0.5em"}}>Edit</span>
                        </MenuButton>
                    </div>
                </div>
                <div className="time-axis">
                    <RegionBound lifecycle={lifecycle} service={service} range={range}/>
                    <TimeAxis lifecycle={lifecycle}
                              service={service}
                              snapping={snapping}
                              range={range}
                              mapper={{
                                  mapPlaybackCursor: (position: number): number => owner.match({
                                      none: () => position,
                                      some: reader => reader.mapPlaybackCursor(position)
                                  })
                              }}/>
                </div>
                {contentEditor}
                <div className="space"/>
                <TimelineRangeSlider lifecycle={lifecycle} range={range}/>
            </div>
        </div>
    )
    const fallback = (box: Box) => (
        <Frag>
            <div className="empty-header"/>
            <div className="label">
                {`No Region Editor for ${box.name} yet.`}&nbsp;<span
                style={{textDecoration: "underline", cursor: "pointer"}}
                onclick={() => editingSubject.clear()}>Close</span>
            </div>
        </Frag>
    )

    const createNoteEditor = (owner: NoteEventOwnerReader) => (
        <NoteEditor lifecycle={runtime}
                    service={service}
                    menu={menu}
                    range={range}
                    snapping={snapping}
                    reader={owner}/>
    )

    const createAudioEditor = (reader: AudioEventOwnerReader) => (
        <AudioEditor lifecycle={runtime}
                     service={service}
                     menu={menu}
                     range={range}
                     snapping={snapping}
                     reader={reader}/>
    )

    const createValueEditor = (reader: ValueEventOwnerReader,
                               collection: PointerField<Pointers.RegionCollection | Pointers.ClipCollection>) => {
        const context = runtime.own(new ParameterValueEditing(service.project, collection))
        return (
            <ValueEventsEditor lifecycle={runtime}
                               service={service}
                               context={context}
                               menu={menu}
                               range={range}
                               snapping={snapping}
                               mapping={ValueMapping.unipolar()}
                               reader={reader}/>
        )
    }

    const updateEditor = deferNextFrame(() => editingSubject.get().match({
        some: (vertex: Vertex) => {
            replaceChildren(contentEditor, vertex.box.accept<BoxVisitor<Element>>({
                visitNoteClipBox: (box: NoteClipBox): Element => {
                    const reader = ClipReader
                        .forNoteClipBoxAdapter(service.project.boxAdapters.adapterFor(box, NoteClipBoxAdapter))
                    owner = Option.wrap(reader)
                    return createNoteEditor(reader)
                },
                visitNoteRegionBox: (box: NoteRegionBox): Element => {
                    const reader = RegionReader.forNoteRegionBoxAdapter(service.project.boxAdapters.adapterFor(box, NoteRegionBoxAdapter))
                    owner = Option.wrap(reader)
                    return createNoteEditor(RegionReader.forNoteRegionBoxAdapter(service.project.boxAdapters.adapterFor(box, NoteRegionBoxAdapter)))
                },
                visitValueClipBox: (box: ValueClipBox): Element => {
                    const reader = ClipReader.forValueClipBoxAdapter(service.project.boxAdapters.adapterFor(box, ValueClipBoxAdapter))
                    owner = Option.wrap(reader)
                    return createValueEditor(reader, box.clips)
                },
                visitValueRegionBox: (box: ValueRegionBox): Element => {
                    const reader = RegionReader.forValueRegionBoxAdapter(service.project.boxAdapters.adapterFor(box, ValueRegionBoxAdapter))
                    owner = Option.wrap(reader)
                    return createValueEditor(reader, box.regions)
                },
                visitAudioClipBox: (box: AudioClipBox): Element => {
                    const reader = ClipReader
                        .forAudioClipBoxAdapter(service.project.boxAdapters.adapterFor(box, AudioClipBoxAdapter))
                    owner = Option.wrap(reader)
                    return createAudioEditor(reader)
                },
                visitAudioRegionBox: (box: AudioRegionBox): Element => {
                    const reader = RegionReader
                        .forAudioRegionBoxAdapter(service.project.boxAdapters.adapterFor(box, AudioRegionBoxAdapter))
                    owner = Option.wrap(reader)
                    return createAudioEditor(reader)
                }
            }) ?? (() => {
                return fallback(vertex.box)
            })()
            )
            AnimationFrame.once(() => element.focus())
        },
        none: () => {
            owner = Option.None
            element.classList.add("disabled")
            replaceChildren(contentEditor, (
                <Frag>
                    <div className="empty-header"/>
                    <div className="label">
                        <p className="help-section">Double-click a region or clip to edit</p>
                    </div>
                </Frag>
            ))
        }
    }))

    lifecycle.ownAll(
        updateEditor,
        editingSubject.catchupAndSubscribe(() => {
            element.classList.remove("disabled")
            runtime.terminate()
            updateEditor.request()
        }),
        Html.watchResize(element, () =>
            element.style.setProperty("--cursor-height", `${(contentEditor.clientHeight + 1)}px`)),
        range.subscribe((() => {
            // FIXME Tried it with a timeout, but it did not behave correctly
            const mainTimelineRange = service.timeline.range
            range.maxUnits = mainTimelineRange.maxUnits
            return () => {
                if (range.maxUnits !== mainTimelineRange.maxUnits) {
                    range.maxUnits = mainTimelineRange.maxUnits
                }
            }
        })()),
        Events.subscribe(element, "keydown", event => {
            if (event.altKey || Keyboard.isControlKey(event) || Events.isTextInput(event.target)) {return}
            const {project: {engine}} = service
            event.preventDefault()
            switch (event.key) {
                case "ArrowLeft": {
                    if (!engine.isPlaying.getValue()) {
                        engine.setPosition(Math.max(0,
                            snapping.ceil(engine.position.getValue()) - snapping.value))
                    }
                    break
                }
                case "ArrowRight": {
                    if (!engine.isPlaying.getValue()) {
                        engine.setPosition(snapping.floor(engine.position.getValue()) + snapping.value)
                    }
                    break
                }
            }
        })
    )
    return element
}