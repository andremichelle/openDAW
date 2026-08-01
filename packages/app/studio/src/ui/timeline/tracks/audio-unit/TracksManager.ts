import {TrackContext} from "@/ui/timeline/tracks/audio-unit/TrackContext.ts"
import {
    Arrays,
    asDefined,
    assert,
    BinarySearch,
    DefaultObservableValue,
    int,
    Lifecycle,
    NumberComparator,
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
import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {StudioService} from "@/service/StudioService.ts"
import {AudioUnitTracks} from "@/ui/timeline/tracks/audio-unit/AudioUnitTracks.tsx"
import {ClipModifier} from "./clips/ClipModifier"
import {Dragging} from "@opendaw/lib-dom"
import {ExtraSpace} from "@/ui/timeline/tracks/audio-unit/Constants"

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
           trackBoxAdapter: TrackBoxAdapter): HTMLElement
}

export class TracksManager implements Terminable {
    readonly #service: StudioService
    readonly #scrollContainer: Element
    readonly #factory: TrackFactory

    readonly #terminator: Terminator
    readonly #audioUnits: SortedSet<UUID.Bytes, { uuid: UUID.Bytes, unitTracks: HTMLElement, lifecycle: Terminable }>
    readonly #tracks: SortedSet<UUID.Bytes, TrackContext>
    readonly #maxClipsIndex: DefaultObservableValue<int>

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
        this.#maxClipsIndex = this.#terminator.own(new DefaultObservableValue(8))
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
                                const element = this.#factory.create(this, trackLifecycle, audioUnitBoxAdapter, trackBoxAdapter)
                                unitTracks.appendChild(element)
                                const track = new TrackContext({
                                    audioUnitBoxAdapter,
                                    trackBoxAdapter,
                                    element,
                                    lifecycle: trackLifecycle
                                })
                                this.#tracks.add(track)
                                trackLifecycle.own({terminate: () => element.remove()})
                                trackLifecycle.own(trackBoxAdapter.catchupAndSubscribePath(option => {
                                    track.path = option
                                    this.#refreshHeaderDedup()
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
                    this.#audioUnits.add({
                        uuid: audioUnitBoxAdapter.uuid,
                        unitTracks,
                        lifecycle: audioUnitLifecycle
                    })
                    this.#invalidateOrder()
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
        // One pass: the sorted order drives the hit-test index and, by re-appending each lane to the end of
        // its unit container, the DOM order — so display, DOM and interaction always agree (grid auto-placement).
        this.tracks().forEach(({trackBoxAdapter, element}, index) => {
            trackBoxAdapter.listIndex = index
            element.parentElement?.appendChild(element)
        })
        this.#refreshHeaderDedup()
    }

    // Header dedup: a lane repeating its predecessor's type icon / device name / label (within the same unit)
    // hides that column — the first lane of each run keeps it. Each column dedups independently.
    #refreshHeaderDedup(): void {
        const tracks = this.tracks()
        tracks.forEach((context, index) => {
            const previous = index > 0 && tracks[index - 1].audioUnitBoxAdapter === context.audioUnitBoxAdapter
                ? Option.wrap(tracks[index - 1])
                : Option.None
            const sameType = previous.mapOr(scope =>
                scope.trackBoxAdapter.type === context.trackBoxAdapter.type, false)
            const sameDevice = previous.mapOr(scope =>
                scope.path.nonEmpty() && context.path.nonEmpty()
                && scope.path.unwrap()[0] === context.path.unwrap()[0], false)
            const sameLabel = previous.mapOr(scope =>
                scope.path.nonEmpty() && context.path.nonEmpty()
                && scope.path.unwrap()[1] === context.path.unwrap()[1], false)
            context.element.classList.toggle("repeat-icon", sameType)
            context.element.classList.toggle("repeat-device", sameDevice)
            context.element.classList.toggle("repeat-label", sameLabel)
        })
    }

    #toSortedTrackScopes(): ReadonlyArray<TrackContext> {
        return this.#tracks.values()
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