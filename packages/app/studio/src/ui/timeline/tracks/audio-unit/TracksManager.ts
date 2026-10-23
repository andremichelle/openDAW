import {AudioUnitBox} from "@opendaw/studio-boxes"
import {TrackListLayout} from "./TrackListLayout"
import {TrackContext} from "@/ui/timeline/tracks/audio-unit/TrackContext.ts"
import {
    Arrays,
    asDefined,
    assert,
    BinarySearch,
    DefaultObservableValue,
    int,
    isDefined,
    isNotNull,
    Lifecycle,
    NumberComparator,
    ObservableOption,
    Option,
    SortedSet,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {
    AudioCompositeAdapter, AudioEffectCompositeCellBoxAdapter, AudioUnitBoxAdapter, AudioUnitInputAdapter, ColorCodes,
    IndexComparator, IndexedBoxAdapter, IndexedBoxAdapterCollection, InstrumentCompositeBoxAdapter,
    InstrumentCompositeCellBoxAdapter, ModulatorBoxAdapter, PlayfieldDeviceBoxAdapter, PlayfieldSampleBoxAdapter,
    TrackBoxAdapter, TrackType
} from "@opendaw/studio-adapters"
import {Pointers} from "@opendaw/studio-enums"
import {StudioPreferences} from "@opendaw/studio-core"
import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {StudioService} from "@/service/StudioService.ts"
import {AudioUnitTracks} from "@/ui/timeline/tracks/audio-unit/AudioUnitTracks.tsx"
import {ClipModifier} from "./clips/ClipModifier"
import {Dragging} from "@opendaw/lib-dom"
import {ExtraSpace} from "@/ui/timeline/tracks/audio-unit/Constants"
import {TrackOrder} from "@/ui/timeline/tracks/audio-unit/TrackOrder"
import {UnitLane} from "@/ui/timeline/tracks/audio-unit/UnitLane.tsx"
import {ModulatorLanes} from "@/ui/timeline/tracks/audio-unit/ModulatorLanes.tsx"
import {ModulatorsLane} from "@/ui/timeline/tracks/audio-unit/ModulatorsLane.tsx"
import {GroupRails} from "@/ui/timeline/tracks/audio-unit/GroupRails"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"

type AudioUnitEntry = {
    uuid: UUID.Bytes
    adapter: AudioUnitBoxAdapter
    unitTracks: HTMLElement
    lifecycle: Terminable
    synthetic: Option<HTMLElement>
}

type RowContent = {kind: "track", track: TrackContext} | {kind: "synthetic" | "modulator-header", element: HTMLElement}

export interface TrackFactory {
    create(manager: TracksManager,
           lifecycle: Lifecycle,
           audioUnitBoxAdapter: AudioUnitBoxAdapter,
           trackBoxAdapter: TrackBoxAdapter,
           unitHead: DefaultObservableValue<boolean>): HTMLElement
    createModulator(manager: TracksManager,
                    lifecycle: Lifecycle,
                    modulator: ModulatorBoxAdapter,
                    trackBoxAdapter: TrackBoxAdapter): HTMLElement
}

export class TracksManager implements Terminable {
    readonly #service: StudioService
    readonly #scrollContainer: Element
    readonly #scrollModel: ScrollModel
    readonly #factory: TrackFactory

    readonly #terminator: Terminator
    readonly #audioUnits: SortedSet<UUID.Bytes, AudioUnitEntry>
    readonly #modulators: SortedSet<UUID.Bytes, {
        uuid: UUID.Bytes, adapter: ModulatorBoxAdapter, lifecycle: Terminable
    }>
    readonly #modulatorLanes: HTMLElement
    readonly #modulatorsHeader: HTMLElement
    readonly #modulatorsCollapsed: DefaultObservableValue<boolean>
    readonly #tracks: SortedSet<UUID.Bytes, TrackContext>
    readonly #groupRails: GroupRails
    readonly #maxClipsIndex: DefaultObservableValue<int>

    #initializing = true
    #layoutQueued = false
    #terminated = false

    #currentClipModifier: Option<ClipModifier> = Option.None
    #currentRegionModifier: Option<RegionModifier> = Option.None
    #layout: Option<TrackListLayout<RowContent>> = Option.None

    constructor(service: StudioService, scrollContainer: Element, scrollModel: ScrollModel, factory: TrackFactory) {
        this.#service = service
        this.#scrollContainer = scrollContainer
        this.#scrollModel = scrollModel
        this.#factory = factory

        this.#terminator = new Terminator()
        this.#audioUnits = UUID.newSet(({uuid}) => uuid)
        this.#modulators = UUID.newSet(({uuid}) => uuid)
        this.#modulatorLanes = ModulatorLanes()
        this.#modulatorsCollapsed = this.#terminator.own(new DefaultObservableValue<boolean>(false))
        this.#modulatorsHeader = ModulatorsLane({
            lifecycle: this.#terminator, service, collapsed: this.#modulatorsCollapsed
        })
        this.#terminator.own(this.#modulatorsCollapsed.subscribe(() => this.#invalidateOrder()))
        this.#tracks = UUID.newSet(({trackBoxAdapter: {uuid}}) => uuid)
        this.#groupRails = this.#terminator.own(new GroupRails(service.project, scrollContainer, false, unit => {
            this.#audioUnits.opt(unit.address.uuid).ifSome(({unitTracks}) => {
                this.#scrollModel.position += unitTracks.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top
            })
        }))
        this.#maxClipsIndex = this.#terminator.own(new DefaultObservableValue(8))
        this.#terminator.own(this.#subscribe())
        this.#initializing = false
        this.#invalidateOrder()
    }

    startClipModifier(option: Option<ClipModifier>): Option<Dragging.Process> {
        return option.map(modifier => {
            assert(this.#currentClipModifier.isEmpty(), "ClipModifier already in use.")
            this.service.regionModifierInProgress = true
            const lifeTime = this.#terminator.spawn()
            lifeTime.own({terminate: () => this.#currentClipModifier = Option.None})
            this.#currentClipModifier = option
            return {
                update: (event: Dragging.Event): void => modifier.update(event),
                approve: (): void => modifier.approve(),
                cancel: (): void => modifier.cancel(),
                finally: (): void => {
                    this.service.regionModifierInProgress = false
                    lifeTime.terminate()
                }
            }
        })
    }

    startRegionModifier(option: Option<RegionModifier>): Option<Dragging.Process> {
        if (this.#currentRegionModifier.nonEmpty()) {
            console.warn(`${this.#currentRegionModifier.unwrap().toString()} is running. Ignore new modifier.`)
            return Option.None
        }
        const print = () => option.unwrapOrNull()?.toString() ?? "unknown"
        console.debug(`start(${print()})`)
        return option.map(modifier => {
            this.service.regionModifierInProgress = true
            const lifeTime = this.#terminator.spawn()
            lifeTime.own({terminate: () => this.#currentRegionModifier = Option.None})
            this.#currentRegionModifier = option
            return {
                update: (event: Dragging.Event): void => modifier.update(event),
                approve: (): void => {
                    console.debug(`approve(${print()})`)
                    modifier.approve()
                },
                cancel: (): void => {
                    console.debug(`cancel(${print()})`)
                    modifier.cancel()
                },
                finally: (): void => {
                    console.debug(`finally(${print()})`)
                    this.service.regionModifierInProgress = false
                    lifeTime.terminate()
                }
            }
        })
    }

    get currentClipModifier(): Option<ClipModifier> {return this.#currentClipModifier}
    get currentRegionModifier(): Option<RegionModifier> {return this.#currentRegionModifier}
    get maxClipsIndex(): DefaultObservableValue<number> {return this.#maxClipsIndex}
    get service(): StudioService {return this.#service}

    localToIndex(position: number): int {
        return position > this.tracksLocalBottom()
            ? this.tracks().length
            : Math.max(0, BinarySearch
                .rightMostMapped(this.tracks(), position, NumberComparator, track => track.position))
    }

    globalToIndex(position: number): int {
        return this.localToIndex(position - this.#trackGlobalTop())
    }

    indexToGlobal(index: int): number {
        if (index < 0) {return 0}
        const tracks = this.tracks()
        // A unit shown by only its synthetic lane contributes no TrackContext: there is no track to place,
        // so the empty band's bottom is the answer (a clip-area marquee here selects nothing, never throws).
        if (tracks.length === 0) {return this.tracksLocalBottom()}
        const offset = this.tracksLocalBottom()
        return asDefined(tracks.at(Math.min(index, tracks.length - 1))).position + offset
    }

    get scrollableContainer(): Element {return this.#scrollContainer}
    get scrollModel(): ScrollModel {return this.#scrollModel}

    unitTracks(uuid: UUID.Bytes): Option<HTMLElement> {return this.#audioUnits.opt(uuid).map(({unitTracks}) => unitTracks)}

    getByIndex(index: number): Option<TrackContext> {return Option.wrap(this.tracks()[index])}

    tracks(): ReadonlyArray<TrackContext> {
        return this.#flatLayout().rows.flatMap(row => row.content.kind === "track" ? [row.content.track] : [])
    }

    numTracks(): int {return this.tracks().length}

    terminate(): void {
        this.#terminated = true
        this.#audioUnits.clear()
        this.#modulators.clear()
        this.#layout = Option.None
        this.#terminator.terminate()
    }

    #subscribe(): Terminable {
        const {project} = this.#service
        const {rootBoxAdapter} = project
        return Terminable.many(
            project.audioUnitLayout.value.subscribe(() => this.#invalidateOrder()),
            project.trackSelection.value.subscribe(() => this.#refreshSelectionRows()),
            project.userEditingManager.audioUnit.catchupAndSubscribe(() => this.#refreshSelectionRows()),
            rootBoxAdapter.audioUnits.catchupAndSubscribe({
                onAdd: (audioUnitBoxAdapter: AudioUnitBoxAdapter) => {
                    const audioUnitLifecycle = this.#terminator.spawn()
                    const unitTracks: HTMLElement = AudioUnitTracks({
                        lifecycle: audioUnitLifecycle,
                        project,
                        adapter: audioUnitBoxAdapter
                    })
                    this.#scrollContainer.appendChild(unitTracks)
                    const entry: AudioUnitEntry = {
                        uuid: audioUnitBoxAdapter.uuid, adapter: audioUnitBoxAdapter,
                        unitTracks, lifecycle: audioUnitLifecycle, synthetic: Option.None
                    }
                    this.#audioUnits.add(entry)
                    audioUnitBoxAdapter.midiEffects.ifSome(chain => this.#watchDeviceChain(audioUnitLifecycle, chain))
                    audioUnitBoxAdapter.audioEffects.ifSome(chain => this.#watchDeviceChain(audioUnitLifecycle, chain))
                    this.#watchLayers(audioUnitLifecycle, audioUnitBoxAdapter.input.adapter())
                    // Collapsing/expanding this unit's automation re-sorts (its value lanes leave/rejoin the set).
                    audioUnitLifecycle.own(audioUnitBoxAdapter.automationCollapsed
                        .subscribe(() => this.#invalidateOrder()))
                    // A unit WITHOUT notes/audio tracks shows one synthetic unit lane (the former
                    // TrackType.Undefined placeholder, now render-only), swapped as content tracks come and go.
                    // The output unit is the exception: it only shows the lane once it HAS automation (a value
                    // track), or when the studio preference forces it (a bare output stays hidden for beginners).
                    const syntheticLifecycle = audioUnitLifecycle.own(new Terminator())
                    const updateSynthetic = () => {
                        const hasContent = audioUnitBoxAdapter.tracks.values()
                            .some(track => track.type === TrackType.Notes || track.type === TrackType.Audio)
                        const wants = !hasContent && (!audioUnitBoxAdapter.isOutput
                            || audioUnitBoxAdapter.tracks.values().length > 0
                            || StudioPreferences.settings.visibility["show-output-track"])
                        const mounted = entry.synthetic.nonEmpty()
                        if (wants && !mounted) {
                            const laneElement = UnitLane({
                                lifecycle: syntheticLifecycle,
                                service: this.#service,
                                trackManager: this,
                                audioUnitBoxAdapter
                            })
                            entry.synthetic = Option.wrap(laneElement)
                            syntheticLifecycle.own({terminate: () => {
                                laneElement.remove()
                                entry.synthetic = Option.None
                            }})
                            this.#scrollContainer.appendChild(laneElement)
                            this.#invalidateOrder()
                        } else if (!wants && mounted) {
                            syntheticLifecycle.terminate()
                            this.#invalidateOrder()
                        }
                    }
                    audioUnitLifecycle.ownAll(
                        {
                            terminate: () => {
                                this.#tracks.values()
                                    .filter(scope => scope.audioUnitBoxAdapter.contains(audioUnitBoxAdapter))
                                    .forEach(scope => this.#tracks.removeByKey(scope.trackBoxAdapter.uuid).lifecycle.terminate())
                                unitTracks.remove()
                                this.#invalidateOrder()
                            }
                        },
                        audioUnitBoxAdapter.tracks.catchupAndSubscribe({
                            onAdd: (trackBoxAdapter: TrackBoxAdapter) => {
                                const trackLifecycle = audioUnitLifecycle.spawn()
                                const unitHead = trackLifecycle.own(new DefaultObservableValue<boolean>(false))
                                const element = this.#factory.create(this, trackLifecycle, audioUnitBoxAdapter, trackBoxAdapter, unitHead)
                                this.#scrollContainer.appendChild(element)
                                const track = new TrackContext({
                                    container: this.#scrollContainer,
                                    owner: {type: "audio-unit", adapter: audioUnitBoxAdapter},
                                    trackBoxAdapter,
                                    element,
                                    lifecycle: trackLifecycle,
                                    unitHead
                                })
                                this.#tracks.add(track)
                                trackLifecycle.own({terminate: () => element.remove()})
                                trackLifecycle.own(trackBoxAdapter.catchupAndSubscribePath(option => {
                                    track.path = option
                                    this.#invalidateOrder()
                                }))
                                this.#invalidateOrder()
                                updateSynthetic()
                            },
                            onRemove: ({uuid}) => {
                                this.#tracks.removeByKey(uuid).lifecycle.terminate()
                                this.#invalidateOrder()
                                updateSynthetic()
                            },
                            onReorder: () => this.#invalidateOrder()
                        }),
                        // The output unit's lane visibility follows the force-output-track preference.
                        StudioPreferences.catchupAndSubscribe(() => updateSynthetic(), "visibility", "show-output-track")
                    )
                    this.#invalidateOrder()
                    updateSynthetic()
                },
                onRemove: (audioUnitBoxAdapter) => {
                    this.#audioUnits.removeByKey(audioUnitBoxAdapter.uuid).lifecycle.terminate()
                    this.#invalidateOrder()
                },
                onReorder: () => this.#invalidateOrder()
            }),
            // A modulator's own automation: its lanes follow every audio unit, so the two collections never
            // interleave and a drop can never land between them.
            rootBoxAdapter.modulators.catchupAndSubscribe({
                onAdd: (modulator: ModulatorBoxAdapter) => {
                    const modulatorLifecycle = this.#terminator.spawn()
                    modulatorLifecycle.ownAll(
                        {
                            terminate: () => {
                                this.#tracks.values()
                                    .filter(scope => scope.owner.adapter === modulator)
                                    .forEach(scope =>
                                        this.#tracks.removeByKey(scope.trackBoxAdapter.uuid).lifecycle.terminate())
                                this.#invalidateOrder()
                            }
                        },
                        modulator.tracks.catchupAndSubscribe({
                            onAdd: (trackBoxAdapter: TrackBoxAdapter) => {
                                const trackLifecycle = modulatorLifecycle.spawn()
                                const element =
                                    this.#factory.createModulator(this, trackLifecycle, modulator, trackBoxAdapter)
                                this.#scrollContainer.appendChild(element)
                                const track = new TrackContext({
                                    container: this.#scrollContainer,
                                    owner: {type: "modulator", adapter: modulator},
                                    trackBoxAdapter,
                                    element,
                                    lifecycle: trackLifecycle,
                                    unitHead: trackLifecycle.own(new DefaultObservableValue<boolean>(false))
                                })
                                this.#tracks.add(track)
                                trackLifecycle.own({terminate: () => element.remove()})
                                trackLifecycle.own(trackBoxAdapter.catchupAndSubscribePath(option => {
                                    track.path = option
                                    this.#invalidateOrder()
                                }))
                                this.#invalidateOrder()
                            },
                            onRemove: ({uuid}) => {
                                this.#tracks.removeByKey(uuid).lifecycle.terminate()
                                this.#invalidateOrder()
                            },
                            onReorder: () => this.#invalidateOrder()
                        })
                    )
                    this.#modulators.add({uuid: modulator.uuid, adapter: modulator, lifecycle: modulatorLifecycle})
                    this.#invalidateOrder()
                },
                onRemove: (modulator: ModulatorBoxAdapter) => {
                    this.#modulators.removeByKey(modulator.uuid).lifecycle.terminate()
                    this.#invalidateOrder()
                },
                onReorder: () => {
                    this.#invalidateOrder()
                }
            })
        )
    }

    // Any device add / remove / re-index anywhere in a unit's chains changes automation-track grouping, so the
    // timeline order must re-sort. Recurses into composite cells and Playfield slots (their chains re-sort too).
    #watchDeviceChain<ADAPTER extends IndexedBoxAdapter, POINTER extends Pointers>(
        lifecycle: Terminator, collection: IndexedBoxAdapterCollection<ADAPTER, POINTER>): void {
        const watchers = UUID.newSet<{uuid: UUID.Bytes, lifecycle: Terminator}>(({uuid}) => uuid)
        lifecycle.own(collection.catchupAndSubscribe({
            onAdd: (adapter: ADAPTER) => {
                const deviceLifecycle = lifecycle.spawn()
                watchers.add({uuid: adapter.uuid, lifecycle: deviceLifecycle})
                if (adapter instanceof AudioCompositeAdapter) {
                    this.#watchDeviceChain(deviceLifecycle, adapter.entries)
                } else if (adapter instanceof AudioEffectCompositeCellBoxAdapter) {
                    adapter.audioEffects.ifSome(chain => this.#watchDeviceChain(deviceLifecycle, chain))
                } else if (adapter instanceof InstrumentCompositeCellBoxAdapter) {
                    adapter.midiEffects.ifSome(chain => this.#watchDeviceChain(deviceLifecycle, chain))
                    adapter.audioEffects.ifSome(chain => this.#watchDeviceChain(deviceLifecycle, chain))
                    this.#watchLayers(deviceLifecycle, adapter.input.adapter())
                } else if (adapter instanceof PlayfieldDeviceBoxAdapter) {
                    this.#watchDeviceChain(deviceLifecycle, adapter.samples)
                } else if (adapter instanceof PlayfieldSampleBoxAdapter) {
                    adapter.midiEffects.ifSome(chain => this.#watchDeviceChain(deviceLifecycle, chain))
                    adapter.audioEffects.ifSome(chain => this.#watchDeviceChain(deviceLifecycle, chain))
                }
                this.#invalidateOrder()
            },
            onRemove: ({uuid}: ADAPTER) => {
                watchers.removeByKey(uuid).lifecycle.terminate()
                this.#invalidateOrder()
            },
            onReorder: () => this.#invalidateOrder()
        }))
    }

    // a composite is the host's instrument, not a chain member, so its layers are followed separately
    #watchLayers(lifecycle: Terminator, instrument: ObservableOption<AudioUnitInputAdapter>): void {
        const instrumentLifecycle = lifecycle.own(new Terminator())
        lifecycle.own(instrument.catchupAndSubscribe(option => {
            instrumentLifecycle.terminate()
            option.ifSome(adapter => {
                if (adapter instanceof InstrumentCompositeBoxAdapter) {
                    this.#watchDeviceChain(instrumentLifecycle, adapter.cells)
                }
            })
            this.#invalidateOrder()
        }))
    }

    #invalidateOrder(): void {
        this.#layout = Option.None
        if (this.#initializing || this.#terminated || this.#layoutQueued) {return}
        const {boxGraph} = this.#service.project
        if (boxGraph.inTransaction()) {
            this.#layoutQueued = true
            boxGraph.subscribeEndTransaction(() => {
                this.#layoutQueued = false
                if (!this.#terminated) {this.#refreshOrder()}
            })
        } else {
            this.#refreshOrder()
        }
    }

    #flatLayout(): TrackListLayout<RowContent> {
        if (this.#layout.isEmpty()) {this.#layout = Option.wrap(this.#computeLayout())}
        return this.#layout.unwrap()
    }

    #computeLayout(): TrackListLayout<RowContent> {
        const sorted = this.#toSortedTrackScopes()
        const channels = new Map<AudioUnitBox, TrackListLayout.Channel<RowContent>>()
        const byUnit = new Map<AudioUnitBox, TrackListLayout.Lane<RowContent>[]>()
        sorted.forEach(track => {
            if (track.owner.type !== "audio-unit") {return}
            const unit = track.owner.adapter.box
            const lanes = byUnit.get(unit) ?? []
            if (!byUnit.has(unit)) {byUnit.set(unit, lanes)}
            lanes.push({content: {kind: "track", track}, automation: track.trackBoxAdapter.type === TrackType.Value})
        })
        this.#audioUnits.values().forEach(entry => {
            const lanes: TrackListLayout.Lane<RowContent>[] = entry.synthetic.mapOr(element =>
                [{content: {kind: "synthetic", element}, automation: false}], [])
            lanes.push(...byUnit.get(entry.adapter.box) ?? [])
            channels.set(entry.adapter.box, {unit: entry.adapter.box,
                automationCollapsed: entry.adapter.automationCollapsed.getValue(), lanes})
        })
        const modulators = sorted.filter(track => track.owner.type === "modulator")
        const tail: RowContent[] = modulators.length > 0
            ? [{kind: "modulator-header", element: this.#modulatorsHeader},
                ...this.#modulatorsCollapsed.getValue() ? [] : modulators.map(track => ({kind: "track" as const, track}))]
            : []
        return new TrackListLayout(this.#service.project.audioUnitLayout.snapshot, channels, tail)
    }

    #element(content: RowContent): HTMLElement {return content.kind === "track" ? content.track.element : content.element}

    #refreshSelectionRows(): void {
        const {project} = this.#service
        this.#flatLayout().rows.forEach(row => {
            const element = this.#element(row.content)
            const selected = isDefined(row.unit) && project.trackSelection.isHighlighted(row.unit)
            element.classList.toggle("editing", selected)
            if (selected) {element.style.setProperty("--wash-color", "var(--color)")}
            else {element.style.removeProperty("--wash-color")}
        })
    }

    #refreshOrder(): void {
        this.#layout = Option.None
        const layout = this.#flatLayout()
        const visible = new Set<Element>(layout.rows.map(row => this.#element(row.content)))
        this.#tracks.values().forEach(track => track.element.classList.toggle("collapsed-away", !visible.has(track.element)))
        this.#audioUnits.values().forEach(entry => entry.synthetic.ifSome(element =>
            element.classList.toggle("collapsed-away", !visible.has(element))))
        this.#modulatorsHeader.classList.toggle("collapsed-away", !visible.has(this.#modulatorsHeader))
        const unitSpans = new Map(layout.units.map(unit => [unit.unit, unit]))
        this.#audioUnits.values().forEach(({adapter, unitTracks}) => {
            const span = unitSpans.get(adapter.box)
            unitTracks.classList.toggle("folder-hidden", !isDefined(span))
            if (!isDefined(span)) {return}
            unitTracks.style.setProperty("--folder-offset", `${span.indent}px`)
            unitTracks.style.gridRow = `${span.start + 1} / ${span.end + 1}`
        })
        layout.rows.forEach(row => {
            const element = this.#element(row.content)
            element.style.gridRow = String(row.index + 1)
            element.style.setProperty("--folder-offset", `${row.indent}px`)
            element.style.setProperty("--color", isDefined(row.unit)
                ? ColorCodes.forAudioType(this.#service.project.boxAdapters.adapterFor(row.unit, AudioUnitBoxAdapter).type).toString()
                : "var(--color-blue)")
            element.classList.toggle("modulator", !isDefined(row.unit))
            if (element.parentElement !== this.#scrollContainer) {this.#scrollContainer.appendChild(element)}
        })
        const current = Array.from(this.#scrollContainer.children).filter(element => visible.has(element))
        if (layout.rows.some((row, index) => this.#element(row.content) !== current[index])) {
            layout.rows.forEach(row => this.#scrollContainer.appendChild(this.#element(row.content)))
        }
        const modulatorHead = layout.rows.find(row => row.content.kind === "modulator-header")
        if (isDefined(modulatorHead)) {
            if (this.#modulatorLanes.parentElement !== this.#scrollContainer) {this.#scrollContainer.prepend(this.#modulatorLanes)}
            this.#modulatorLanes.style.gridRow = `${modulatorHead.index + 1} / ${layout.rows.length + 1}`
        } else {this.#modulatorLanes.remove()}
        const extra = this.#scrollContainer.querySelector<HTMLElement>(":scope > .extra")
        if (isNotNull(extra)) {extra.style.gridRow = String(layout.rows.length + 1)}
        this.#groupRails.update(layout.boundaries)
        this.tracks().forEach(({trackBoxAdapter}, index) => trackBoxAdapter.listIndex = index)
        this.#refreshSelectionRows()
        this.#refreshHeaderDedup()
    }

    // Header dedup + tree guides: a device GROUP is a run of lanes sharing unit, type and device name. The
    // first lane shows the device name, every lane always shows its own label, and the guide runs from the
    // device name down to the group's last label ("group-end"). The unit icon shows once per unit-run.
    // A device GROUP: lanes sharing unit, track type and device name (consecutive in display order).
    #sameGroup(a: TrackContext, b: TrackContext): boolean {
        return a.owner.adapter === b.owner.adapter
            && a.trackBoxAdapter.type === b.trackBoxAdapter.type
            && a.path.nonEmpty() && b.path.nonEmpty()
            && a.path.unwrap()[0] === b.path.unwrap()[0]
    }

    // The display-ordered members of the device group containing `uuid` (empty when unknown).
    groupMembers(uuid: UUID.Bytes): ReadonlyArray<TrackContext> {
        const tracks = this.tracks()
        const center = tracks.findIndex(context => UUID.equals(context.trackBoxAdapter.uuid, uuid))
        if (center === -1) {return Arrays.empty()}
        let first = center
        while (first > 0 && this.#sameGroup(tracks[first - 1], tracks[center])) {first--}
        let last = center
        while (last < tracks.length - 1 && this.#sameGroup(tracks[last + 1], tracks[center])) {last++}
        return tracks.slice(first, last + 1)
    }

    #refreshHeaderDedup(): void {
        const tracks = this.tracks()
        const sameGroup = (a: TrackContext, b: TrackContext): boolean => this.#sameGroup(a, b)
        // A unit shown by its synthetic lane already carries the icon there, so every real lane below it
        // repeats the unit and must hide it, the first one included.
        const showsUnitLane = (context: TrackContext): boolean => context.audioUnitBoxAdapter
            .flatMap(adapter => this.#audioUnits.opt(adapter.uuid)).mapOr(entry => entry.synthetic.nonEmpty(), false)
        tracks.forEach((context, index) => {
            // Head duties (channel controls, unit drag) live on the unit's FIRST DISPLAYED lane — always a
            // content track (they sort first); a unit without one delegates to its synthetic lane instead.
            const firstOfUnit = index === 0 || tracks[index - 1].owner.adapter !== context.owner.adapter
            const hasContent = context.audioUnitBoxAdapter.mapOr(unit => unit.tracks.values()
                .some(track => track.type === TrackType.Notes || track.type === TrackType.Audio), false)
            context.unitHead.setValue(firstOfUnit && hasContent)
            const previous = index > 0 ? Option.wrap(tracks[index - 1]) : Option.None
            const next = index < tracks.length - 1 ? Option.wrap(tracks[index + 1]) : Option.None
            // A content lane's icon shows the UNIT, so it repeats on every further lane of the same unit. A value
            // lane carries the automation glyph instead, which repeats only within the unit's run of value lanes.
            // The modulators form ONE unit-like group, so its lanes share a unit run across modulators; a
            // single modulator is a device inside it, which the device-name dedup below still separates.
            const sameUnit = (scope: TrackContext): boolean =>
                scope.owner.type === "modulator" && context.owner.type === "modulator"
                || scope.owner.adapter === context.owner.adapter
            context.element.classList.toggle("repeat-icon",
                context.trackBoxAdapter.type === TrackType.Value
                    ? previous.mapOr(scope => sameUnit(scope)
                        && scope.trackBoxAdapter.type === TrackType.Value, false)
                    : showsUnitLane(context) || previous.mapOr(sameUnit, false))
            context.element.classList.toggle("repeat-device", previous.mapOr(scope => sameGroup(scope, context), false))
            context.element.classList.toggle("group-end", next.mapOr(scope => !sameGroup(context, scope), true))
            context.element.classList.toggle("no-guide",
                context.path.mapOr(path => path[1].trim().length === 0, true)
                || !previous.mapOr(scope => sameGroup(scope, context), false)
                && !next.mapOr(scope => sameGroup(scope, context), false))
        })
    }

    #toSortedTrackScopes(): ReadonlyArray<TrackContext> {
        const order = new Map(this.#service.project.audioUnitLayout.snapshot.rows.map(row => [row.unit, row.order]))
        return this.#tracks.values()
            .toSorted((a: TrackContext, b: TrackContext) => {
                // Modulator lanes sit after every audio unit, so the two collections never interleave.
                if (a.owner.type !== b.owner.type) {return a.owner.type === "modulator" ? 1 : -1}
                const unitDiff = IndexComparator(
                    a.owner.type === "audio-unit" ? (order.get(a.owner.adapter.box) ?? -1) : a.owner.adapter.indexField.getValue(),
                    b.owner.type === "audio-unit" ? (order.get(b.owner.adapter.box) ?? -1) : b.owner.adapter.indexField.getValue())
                if (unitDiff !== 0) {return unitDiff}
                if (a.owner.type === "modulator") {
                    return IndexComparator(a.trackBoxAdapter.indexField.getValue(),
                        b.trackBoxAdapter.indexField.getValue())
                }
                const boxAdapters = this.#service.project.boxAdapters
                const orderDiff = TrackOrder.compare(
                    TrackOrder.keyOf(boxAdapters, a.trackBoxAdapter), TrackOrder.keyOf(boxAdapters, b.trackBoxAdapter))
                if (orderDiff !== 0) {return orderDiff}
                return IndexComparator(a.trackBoxAdapter.indexField.getValue(), b.trackBoxAdapter.indexField.getValue())
            })
    }

    #trackGlobalTop() {return this.#scrollContainer.getBoundingClientRect().top - this.#scrollContainer.scrollTop}
    tracksLocalBottom(): number {return this.#scrollContainer.scrollHeight - ExtraSpace}
}