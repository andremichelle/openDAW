import css from "./AudioUnitsTimeline.sass?inline"
import {Lifecycle, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Scroller} from "@/ui/components/Scroller.tsx"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {TrackFactory, TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {Track} from "./Track"
import {RegionsArea} from "./regions/RegionsArea.tsx"
import {ClipsArea} from "./clips/ClipsArea.tsx"
import {AudioUnitBoxAdapter, InstrumentFactories, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {ExtraSpace} from "./Constants.ts"
import {HeadersArea} from "@/ui/timeline/tracks/audio-unit/headers/HeadersArea"
import {Icon} from "@/ui/components/Icon"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MenuButton} from "@/ui/components/MenuButton"
import {AudioUnitsClipboard, ClipboardManager, MenuItem} from "@opendaw/studio-core"
import {DefaultInstrumentFactory} from "@/ui/defaults/DefaultInstrumentFactory"
import {AudioUnitBox} from "@opendaw/studio-boxes"

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
                 trackBoxAdapter: TrackBoxAdapter): HTMLElement => (
            <Track lifecycle={lifecycle}
                   service={service}
                   trackManager={manager}
                   audioUnitBoxAdapter={audioUnitBoxAdapter}
                   trackBoxAdapter={trackBoxAdapter}/>
        )
    }
    const manager: TracksManager = lifecycle.own(new TracksManager(service, scrollContainer, factory))
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
        ClipboardManager.install(element, AudioUnitsClipboard.createHandler({
            getEnabled: () => true,
            editing,
            boxGraph,
            rootBoxAdapter,
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
        Events.subscribe(scrollContainer, "scroll", () => scrollModel.position = scrollContainer.scrollTop)
    )
    element.style.setProperty("--extra-space", `${ExtraSpace}px`)
    return element
}