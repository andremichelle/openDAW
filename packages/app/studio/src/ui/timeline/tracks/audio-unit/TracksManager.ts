import {TrackContext} from "@/ui/timeline/tracks/audio-unit/TrackContext.ts"
import {
    Arrays,
    asDefined,
    assert,
    BinarySearch,
    DefaultObservableValue,
    int,
    isNotNull,
    Lifecycle,
    NumberComparator,
    Nullable,
    Option,
    SortedSet,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {
    AudioCompositeAdapter, AudioEffectCompositeCellBoxAdapter, AudioUnitBoxAdapter, BoxAdapters, DeviceBoxAdapter,
    DeviceHost, Devices, IndexComparator, IndexedBoxAdapter, IndexedBoxAdapterCollection,
    PlayfieldDeviceBoxAdapter, PlayfieldSampleBoxAdapter, TrackBoxAdapter, TrackType
} from "@opendaw/studio-adapters"
import {Box} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {StudioPreferences} from "@opendaw/studio-core"
import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {StudioService} from "@/service/StudioService.ts"
import {AudioUnitTracks} from "@/ui/timeline/tracks/audio-unit/AudioUnitTracks.tsx"
import {ClipModifier} from "./clips/ClipModifier"
import {Dragging} from "@opendaw/lib-dom"
import {ExtraSpace} from "@/ui/timeline/tracks/audio-unit/Constants"
import {UnitLane} from "@/ui/timeline/tracks/audio-unit/UnitLane.tsx"

// Group order within a unit (mirrors the device panel): instrument tracks, midi-fx automation, instrument
// automation, audio-fx automation. `path` is the device's index chain from the unit's chain down through
// nested composites (composite index, cell/slot index, inner device index, ...), compared lexicographically,
// so one device's automation stays together and nested devices sort right after their composite.
type TrackOrderKey = {category: int, path: ReadonlyArray<int>}

const InstrumentTracks: TrackOrderKey = {category: 0, path: Arrays.empty()}
const Unresolved: TrackOrderKey = {category: 9, path: Arrays.empty()}

// A composite's nested chain host (FX Composite cell, Playfield slot) with its branch index and owning device.
const nestedHost = (host: DeviceHost): Option<{parent: DeviceBoxAdapter, index: int}> =>
    host instanceof AudioEffectCompositeCellBoxAdapter
        ? Option.wrap({parent: host.compositeDevice(), index: host.indexField.getValue()})
        : host instanceof PlayfieldSampleBoxAdapter
            ? Option.wrap({parent: host.device(), index: host.indexField.getValue()})
            : Option.None

const deviceOrderKey = (adapter: DeviceBoxAdapter): TrackOrderKey => {
    const ownIndex = Devices.isEffect(adapter) ? adapter.indexField.getValue() : 0
    const host = adapter.deviceHost()
    if (host.isAudioUnit) {
        const category = Devices.isMidiEffect(adapter) ? 1
            : Devices.isInstrument(adapter) ? 2
                : Devices.isAudioEffect(adapter) ? 3 : 9
        return {category, path: [ownIndex]}
    }
    return nestedHost(host).match({
        none: () => ({category: 9, path: [ownIndex]}),
        some: ({parent, index}) => {
            const outer = deviceOrderKey(parent)
            return {category: outer.category, path: [...outer.path, index, ownIndex]}
        }
    })
}

// An indirectly targeted parameter (modular) reaches its device through a Parameter edge
// (mirrors TrackBoxAdapter#resolveOwnerDeviceBox).
const ownerDeviceBox = (box: Box): Option<Box> => {
    for (const [pointer] of box.outgoingEdges()) {
        if (pointer.pointerType === Pointers.Parameter) {
            return pointer.targetVertex.map(vertex => vertex.box)
        }
    }
    return Option.None
}

const trackOrderKey = (boxAdapters: BoxAdapters, adapter: TrackBoxAdapter): TrackOrderKey => {
    if (adapter.type !== TrackType.Value) {return InstrumentTracks}
    return adapter.target.targetVertex.match({
        none: () => Unresolved,
        some: targetVertex => {
            const box = targetVertex.box
            const direct = boxAdapters.optAdapter(box).flatMap(deviceAdapter =>
                Devices.isAny(deviceAdapter) ? Option.wrap(deviceAdapter) : Option.None)
            const resolved = direct.nonEmpty()
                ? direct
                : ownerDeviceBox(box)
                    .flatMap(owner => boxAdapters.optAdapter(owner))
                    .flatMap(deviceAdapter =>
                        Devices.isAny(deviceAdapter) ? Option.wrap(deviceAdapter) : Option.None)
            return resolved.mapOr(deviceOrderKey, Unresolved)
        }
    })
}

const comparePaths = (a: ReadonlyArray<int>, b: ReadonlyArray<int>): int => {
    const shared = Math.min(a.length, b.length)
    for (let level = 0; level < shared; level++) {
        if (a[level] !== b[level]) {return a[level] - b[level]}
    }
    return a.length - b.length
}

export interface TrackFactory {
    create(manager: TracksManager,
           lifecycle: Lifecycle,
           audioUnitBoxAdapter: AudioUnitBoxAdapter,
           trackBoxAdapter: TrackBoxAdapter,
           unitHead: DefaultObservableValue<boolean>): HTMLElement
}

export class TracksManager implements Terminable {
    readonly #service: StudioService
    readonly #scrollContainer: Element
    readonly #factory: TrackFactory

    readonly #terminator: Terminator
    readonly #audioUnits: SortedSet<UUID.Bytes, { uuid: UUID.Bytes, unitTracks: HTMLElement, lifecycle: Terminable }>
    readonly #tracks: SortedSet<UUID.Bytes, TrackContext>
    #currentClipModifier: Option<ClipModifier> = Option.None
    #currentRegionModifier: Option<RegionModifier> = Option.None
    #orderedByIndex: Option<ReadonlyArray<TrackContext>> = Option.None

    constructor(service: StudioService, scrollContainer: Element, factory: TrackFactory) {
        this.#service = service
        this.#scrollContainer = scrollContainer
        this.#factory = factory

        this.#terminator = new Terminator()
        this.#audioUnits = UUID.newSet(({uuid}) => uuid)
        this.#tracks = UUID.newSet(({trackBoxAdapter: {uuid}}) => uuid)
        this.#terminator.own(this.#subscribe())
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

    getByIndex(index: number): Option<TrackContext> {return Option.wrap(this.tracks()[index])}

    tracks(): ReadonlyArray<TrackContext> {
        if (this.#audioUnits.size() === 0) {return Arrays.empty()}
        if (this.#orderedByIndex.isEmpty()) {
            this.#orderedByIndex = Option.wrap(this.#toSortedTrackScopes())
        }
        return this.#orderedByIndex.unwrap()
    }

    numTracks(): int {return this.tracks().length}

    terminate(): void {
        this.#audioUnits.clear()
        this.#orderedByIndex = Option.None
        this.#terminator.terminate()
    }

    #subscribe(): Terminable {
        const {project} = this.#service
        const {rootBoxAdapter} = project
        return Terminable.many(
            rootBoxAdapter.audioUnits.catchupAndSubscribe({
                onAdd: (audioUnitBoxAdapter: AudioUnitBoxAdapter) => {
                    const audioUnitLifecycle = this.#terminator.spawn()
                    const unitTracks: HTMLElement = AudioUnitTracks({
                        lifecycle: audioUnitLifecycle,
                        project,
                        adapter: audioUnitBoxAdapter
                    })
                    this.#scrollContainer.appendChild(unitTracks)
                    audioUnitBoxAdapter.midiEffects.ifSome(chain => this.#watchDeviceChain(audioUnitLifecycle, chain))
                    audioUnitBoxAdapter.audioEffects.ifSome(chain => this.#watchDeviceChain(audioUnitLifecycle, chain))
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
                        const mounted = isNotNull(unitTracks.querySelector(":scope > .unit-lane"))
                        if (wants && !mounted) {
                            const laneElement = UnitLane({
                                lifecycle: syntheticLifecycle,
                                service: this.#service,
                                audioUnitBoxAdapter
                            })
                            syntheticLifecycle.own({terminate: () => laneElement.remove()})
                            unitTracks.prepend(laneElement)
                            this.#refreshHeaderDedup()
                        } else if (!wants && mounted) {
                            syntheticLifecycle.terminate()
                            this.#refreshHeaderDedup()
                        }
                    }
                    audioUnitLifecycle.ownAll(
                        {
                            terminate: () => {
                                this.#tracks.values()
                                    .filter(scope => scope.audioUnitBoxAdapter === audioUnitBoxAdapter)
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
                                unitTracks.appendChild(element)
                                const track = new TrackContext({
                                    audioUnitBoxAdapter,
                                    trackBoxAdapter,
                                    element,
                                    lifecycle: trackLifecycle,
                                    unitHead
                                })
                                this.#tracks.add(track)
                                trackLifecycle.own({terminate: () => element.remove()})
                                trackLifecycle.own(trackBoxAdapter.catchupAndSubscribePath(option => {
                                    track.path = option
                                    this.#refreshHeaderDedup()
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
                    this.#audioUnits.add({
                        uuid: audioUnitBoxAdapter.uuid,
                        unitTracks,
                        lifecycle: audioUnitLifecycle
                    })
                    this.#invalidateOrder()
                    updateSynthetic()
                },
                onRemove: (audioUnitBoxAdapter) => {
                    this.#audioUnits.removeByKey(audioUnitBoxAdapter.uuid).lifecycle.terminate()
                    this.#invalidateOrder()
                },
                onReorder: () => this.#invalidateOrder()
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

    #invalidateOrder(): void {
        this.#orderedByIndex = Option.None
        // The sorted order drives the hit-test index and the DOM order (grid auto-placement), so display,
        // DOM and interaction always agree. The DOM is only touched when a container's order actually
        // deviates: appendChild MOVES a node, and moving the element a native drag was just pressed on
        // silently cancels the drag (the "first drag dead, second works" symptom).
        // Collapsed automation lanes are display:none'd out of flow; everything else is shown.
        this.#tracks.values().forEach(track =>
            track.element.classList.toggle("collapsed-away", this.#isCollapsedAway(track)))
        const tracks = this.tracks()
        tracks.forEach(({trackBoxAdapter}, index) => trackBoxAdapter.listIndex = index)
        const byParent = new Map<HTMLElement, Array<HTMLElement>>()
        tracks.forEach(({element}) => {
            const parent: Nullable<HTMLElement> = element.parentElement
            if (isNotNull(parent)) {
                const list = byParent.get(parent) ?? []
                if (list.length === 0) {byParent.set(parent, list)}
                list.push(element)
            }
        })
        byParent.forEach((elements, parent) => {
            // The synthetic unit lane and collapsed-away lanes stay put, outside the sorted (visible) set.
            const current = Array.from(parent.children).filter(child =>
                !child.classList.contains("unit-lane") && !child.classList.contains("collapsed-away"))
            const inOrder = current.length === elements.length
                && elements.every((lane, index) => current[index] === lane)
            if (!inOrder) {elements.forEach(lane => parent.appendChild(lane))}
        })
        this.#refreshHeaderDedup()
    }

    // Header dedup + tree guides: a device GROUP is a run of lanes sharing unit, type and device name. The
    // first lane shows the device name, every lane always shows its own label, and the guide runs from the
    // device name down to the group's last label ("group-end"). The unit icon shows once per unit-run.
    // A device GROUP: lanes sharing unit, track type and device name (consecutive in display order).
    #sameGroup(a: TrackContext, b: TrackContext): boolean {
        return a.audioUnitBoxAdapter === b.audioUnitBoxAdapter
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
        const showsUnitLane = (context: TrackContext): boolean =>
            Option.wrap(context.element.parentElement)
                .mapOr(parent => isNotNull(parent.querySelector(":scope > .unit-lane")), false)
        tracks.forEach((context, index) => {
            // Head duties (channel controls, unit drag) live on the unit's FIRST DISPLAYED lane — always a
            // content track (they sort first); a unit without one delegates to its synthetic lane instead.
            const firstOfUnit = index === 0 || tracks[index - 1].audioUnitBoxAdapter !== context.audioUnitBoxAdapter
            const hasContent = context.audioUnitBoxAdapter.tracks.values()
                .some(track => track.type === TrackType.Notes || track.type === TrackType.Audio)
            context.unitHead.setValue(firstOfUnit && hasContent)
            const previous = index > 0 ? Option.wrap(tracks[index - 1]) : Option.None
            const next = index < tracks.length - 1 ? Option.wrap(tracks[index + 1]) : Option.None
            // A content lane's icon shows the UNIT, so it repeats on every further lane of the same unit. A value
            // lane carries the automation glyph instead, which repeats only within the unit's run of value lanes.
            const sameUnit = (scope: TrackContext): boolean =>
                scope.audioUnitBoxAdapter === context.audioUnitBoxAdapter
            context.element.classList.toggle("repeat-icon",
                context.trackBoxAdapter.type === TrackType.Value
                    ? previous.mapOr(scope => sameUnit(scope)
                        && scope.trackBoxAdapter.type === TrackType.Value, false)
                    : showsUnitLane(context) || previous.mapOr(sameUnit, false))
            context.element.classList.toggle("repeat-device", previous.mapOr(scope => sameGroup(scope, context), false))
            context.element.classList.toggle("group-end", next.mapOr(scope => !sameGroup(context, scope), true))
            context.element.classList.toggle("no-guide",
                context.path.mapOr(path => path[1].trim().length === 0, true))
        })
    }

    // A value (automation) track hidden because its unit's automation is collapsed. Such tracks leave the
    // sorted set entirely (no hit-test, no display order) and their element is display:none'd.
    #isCollapsedAway(track: TrackContext): boolean {
        return track.trackBoxAdapter.type === TrackType.Value
            && track.audioUnitBoxAdapter.automationCollapsed.getValue()
    }

    #toSortedTrackScopes(): ReadonlyArray<TrackContext> {
        return this.#tracks.values()
            .filter(scope => !this.#isCollapsedAway(scope))
            .toSorted((a: TrackContext, b: TrackContext) => {
                const unitDiff = IndexComparator(
                    a.audioUnitBoxAdapter.indexField.getValue(),
                    b.audioUnitBoxAdapter.indexField.getValue())
                if (unitDiff !== 0) {return unitDiff}
                const boxAdapters = this.#service.project.boxAdapters
                const keyA = trackOrderKey(boxAdapters, a.trackBoxAdapter)
                const keyB = trackOrderKey(boxAdapters, b.trackBoxAdapter)
                if (keyA.category !== keyB.category) {return keyA.category - keyB.category}
                const pathDiff = comparePaths(keyA.path, keyB.path)
                if (pathDiff !== 0) {return pathDiff}
                return IndexComparator(a.trackBoxAdapter.indexField.getValue(), b.trackBoxAdapter.indexField.getValue())
            })
    }

    #trackGlobalTop() {return this.#scrollContainer.getBoundingClientRect().top - this.#scrollContainer.scrollTop}
    tracksLocalBottom(): number {return this.#scrollContainer.scrollHeight - ExtraSpace}
}
