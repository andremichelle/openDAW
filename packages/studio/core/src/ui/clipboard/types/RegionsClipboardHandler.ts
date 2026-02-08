import {ByteArrayInput, ByteArrayOutput, Option, Procedure, Provider, Selection, UUID} from "@opendaw/lib-std"
import {Box, BoxEditing, BoxGraph} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {Pointers} from "@opendaw/studio-enums"
import {
    AnyRegionBoxAdapter,
    BoxAdapters,
    RegionAdapters,
    TrackBoxAdapter,
    TrackType,
    UnionBoxTypes
} from "@opendaw/studio-adapters"
import {ClipboardEntry, ClipboardHandler} from "../ClipboardManager"
import {ClipboardUtils} from "../ClipboardUtils"
import {RegionOverlapResolver} from "../../timeline/RegionOverlapResolver"

type ClipboardRegions = ClipboardEntry<"regions">

type TrackInfo = {
    readonly uuid: UUID.Bytes
    readonly offset: number
    readonly type: TrackType
}

type RegionsMetadata = {
    readonly minPosition: ppqn
    readonly maxPosition: ppqn
    readonly tracks: ReadonlyArray<TrackInfo>
}

export namespace RegionsClipboard {
    export type Context = {
        readonly getEnabled: Provider<boolean>
        readonly getPosition: Provider<ppqn>
        readonly setPosition: Procedure<ppqn>
        readonly editing: BoxEditing
        readonly selection: Selection<AnyRegionBoxAdapter>
        readonly boxGraph: BoxGraph
        readonly boxAdapters: BoxAdapters
        readonly getTracks: Provider<ReadonlyArray<TrackBoxAdapter>>
        readonly getFocusedTrack: Provider<Option<TrackBoxAdapter>>
        readonly overlapResolver: RegionOverlapResolver
    }

    const encodeMetadata = (metadata: RegionsMetadata): ArrayBufferLike => {
        const output = ByteArrayOutput.create()
        output.writeFloat(metadata.minPosition)
        output.writeFloat(metadata.maxPosition)
        output.writeInt(metadata.tracks.length)
        for (const track of metadata.tracks) {
            output.writeBytes(new Int8Array(track.uuid))
            output.writeInt(track.offset)
            output.writeInt(track.type)
        }
        return output.toArrayBuffer()
    }

    const decodeMetadata = (buffer: ArrayBufferLike): RegionsMetadata => {
        const input = new ByteArrayInput(buffer)
        const minPosition = input.readFloat()
        const maxPosition = input.readFloat()
        const count = input.readInt()
        const tracks: TrackInfo[] = []
        for (let i = 0; i < count; i++) {
            const uuid = new Uint8Array(16) as UUID.Bytes
            input.readBytes(new Int8Array(uuid.buffer))
            const offset = input.readInt()
            const type = input.readInt() as TrackType
            tracks.push({uuid, offset, type})
        }
        return {minPosition, maxPosition, tracks}
    }

    export const createHandler = ({
                                      getEnabled,
                                      getPosition,
                                      setPosition,
                                      editing,
                                      selection,
                                      boxGraph,
                                      boxAdapters,
                                      getTracks,
                                      getFocusedTrack,
                                      overlapResolver
                                  }: Context): ClipboardHandler<ClipboardRegions> => {
        const copyRegions = (): Option<ClipboardRegions> => {
            const selected = selection.selected()
            if (selected.length === 0) {return Option.None}
            const allTracks = getTracks()
            const trackIndexMap = new Map<TrackBoxAdapter, number>()
            allTracks.forEach((track, index) => trackIndexMap.set(track, index))
            const sourceTracks = selected.flatMap(region =>
                region.trackBoxAdapter.match({some: track => [track], none: () => []}))
            if (sourceTracks.length === 0) {return Option.None}
            const sourceTrackIndices = sourceTracks
                .map(track => trackIndexMap.get(track))
                .filter((index): index is number => index !== undefined)
            const minTrackIndex = Math.min(...sourceTrackIndices)
            const uniqueTracks = UUID.newSet<TrackBoxAdapter>(track => track.uuid)
            sourceTracks.forEach(track => uniqueTracks.add(track))
            const trackInfos: TrackInfo[] = uniqueTracks.values().map(track => ({
                uuid: track.uuid,
                offset: (trackIndexMap.get(track) ?? 0) - minTrackIndex,
                type: track.type
            }))
            const minPosition = Math.min(...selected.map(region => region.position))
            const maxPosition = Math.max(...selected.map(region => region.complete))
            const regionBoxes = selected.map(region => region.box)
            const dependencies = regionBoxes.flatMap(box =>
                Array.from(boxGraph.dependenciesOf(box, {
                    alwaysFollowMandatory: true,
                    stopAtResources: true,
                    excludeBox: (dep: Box) => dep.ephemeral
                }).boxes))
            const allBoxes = [...regionBoxes, ...dependencies]
            const metadata: RegionsMetadata = {minPosition, maxPosition, tracks: trackInfos}
            const data = ClipboardUtils.serializeBoxes(allBoxes, encodeMetadata(metadata))
            setPosition(maxPosition)
            return Option.wrap({type: "regions", data})
        }
        return {
            canCopy: (): boolean => getEnabled() && selection.nonEmpty(),
            canCut: (): boolean => getEnabled() && selection.nonEmpty(),
            canPaste: (entry: ClipboardEntry): boolean => getEnabled() && entry.type === "regions",
            copy: copyRegions,
            cut: (): Option<ClipboardRegions> => {
                const result = copyRegions()
                result.ifSome(() => editing.modify(() => selection.selected().forEach(region => region.box.delete())))
                return result
            },
            paste: (entry: ClipboardEntry): void => {
                if (entry.type !== "regions" || !getEnabled()) {return}
                const position = getPosition()
                const metadata = decodeMetadata(ClipboardUtils.extractMetadata(entry.data))
                const positionOffset = Math.max(0, position) - metadata.minPosition
                const allTracks = getTracks()
                const focusedTrack = getFocusedTrack()
                if (focusedTrack.isEmpty() || allTracks.length === 0) {return}
                const focusedTrackIndex = allTracks.indexOf(focusedTrack.unwrap())
                if (focusedTrackIndex === -1) {return}
                const sourceTrackToTarget = UUID.newSet<{uuid: UUID.Bytes, target: TrackBoxAdapter}>(entry => entry.uuid)
                for (const trackInfo of metadata.tracks) {
                    const targetIndex = focusedTrackIndex + trackInfo.offset
                    const targetTrack = allTracks[targetIndex]
                    if (!targetTrack || targetTrack.type !== trackInfo.type) {return}
                    sourceTrackToTarget.add({uuid: trackInfo.uuid, target: targetTrack})
                }
                editing.modify(() => {
                    selection.deselectAll()
                    const pastePosition = Math.max(0, position)
                    const pasteComplete = pastePosition + (metadata.maxPosition - metadata.minPosition)
                    const overlapSolvers = sourceTrackToTarget.values()
                        .map(({target}) => overlapResolver.fromRange(target, pastePosition, pasteComplete))
                    const boxes = ClipboardUtils.deserializeBoxes(
                        entry.data,
                        boxGraph,
                        {
                            mapPointer: (pointer, address) => {
                                if (pointer.pointerType === Pointers.RegionCollection) {
                                    return address.flatMap(addr => sourceTrackToTarget.opt(addr.uuid)
                                        .map(({target}) => target.box.regions.address))
                                }
                                if (pointer.pointerType === Pointers.ClipCollection) {
                                    return address.flatMap(addr => sourceTrackToTarget.opt(addr.uuid)
                                        .map(({target}) => target.box.clips.address))
                                }
                                return Option.None
                            },
                            modifyBox: (box: Box) => {
                                if (UnionBoxTypes.isRegionBox(box)) {
                                    const regionBox = UnionBoxTypes.asRegionBox(box)
                                    regionBox.position.setValue(regionBox.position.getValue() + positionOffset)
                                }
                            }
                        }
                    )
                    overlapSolvers.forEach(solver => solver())
                    const regionBoxes = boxes.filter(UnionBoxTypes.isRegionBox)
                    const adapters = regionBoxes.map(box => RegionAdapters.for(boxAdapters, box))
                    selection.select(...adapters)
                    setPosition(pasteComplete)
                })
            }
        }
    }
}
