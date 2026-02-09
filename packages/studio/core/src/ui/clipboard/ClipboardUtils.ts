import {ByteArrayInput, ByteArrayOutput, Option, Predicate, Procedure, UUID} from "@opendaw/lib-std"
import {Box, BoxGraph, PointerField, SpecialDecoder} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"

type UUIDMapper = { source: UUID.Bytes, target: UUID.Bytes }

export namespace ClipboardUtils {
    export const extractMetadata = (data: ArrayBufferLike): ArrayBufferLike => {
        const input = new ByteArrayInput(data)
        const metadataLength = input.readInt()
        const metadataBytes = new Int8Array(metadataLength)
        input.readBytes(metadataBytes)
        return metadataBytes.buffer
    }

    export const serializeBoxes = (boxes: ReadonlyArray<Box>,
                                   metadata: ArrayBufferLike = new ArrayBuffer(0)): ArrayBufferLike => {
        const uniqueBoxes = UUID.newSet<Box>(box => box.address.uuid)
        boxes.forEach(box => uniqueBoxes.add(box))
        const typeCounts = new Map<string, number>()
        uniqueBoxes.forEach(box => typeCounts.set(box.name, (typeCounts.get(box.name) ?? 0) + 1))
        const types = [...typeCounts.entries()].map(([type, count]) => `${type}: ${count}`).join(", ")
        const clipboardGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        clipboardGraph.beginTransaction()
        uniqueBoxes.forEach(sourceBox => {
            const input = new ByteArrayInput(sourceBox.toArrayBuffer())
            clipboardGraph.createBox(sourceBox.name as keyof BoxIO.TypeMap, sourceBox.address.uuid, box => box.read(input))
        })
        clipboardGraph.endTransaction()
        const graphData = clipboardGraph.toArrayBuffer()
        const output = ByteArrayOutput.create()
        output.writeInt(metadata.byteLength)
        output.writeBytes(new Int8Array(metadata))
        output.writeInt(graphData.byteLength)
        output.writeBytes(new Int8Array(graphData))
        const arrayBuffer = output.toArrayBuffer()
        console.debug(`Clipboard copy (${arrayBuffer.byteLength >> 10}kB): ${types}`)
        return arrayBuffer
    }

    export const deserializeBoxes = <T extends Box = Box>(data: ArrayBufferLike,
                                                          targetGraph: BoxGraph,
                                                          options: {
                                                              mapPointer: SpecialDecoder["map"]
                                                              modifyBox?: Procedure<T>
                                                              excludeBox?: Predicate<Box>
                                                          }): ReadonlyArray<T> => {
        const input = new ByteArrayInput(data)
        input.skip(input.readInt())
        const graphDataLength = input.readInt()
        const graphData = new Int8Array(graphDataLength)
        input.readBytes(graphData)
        const clipboardGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        clipboardGraph.fromArrayBuffer(graphData.buffer)
        const skippedExternalUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
        clipboardGraph.boxes().forEach(box => {
            if (box.resource === "preserved" && targetGraph.findBox(box.address.uuid).nonEmpty()) {
                skippedExternalUuids.add(box.address.uuid)
            }
        })
        const shouldSkipBox = (box: Box): boolean => {
            if (options.excludeBox?.(box)) {return true}
            if (box.resource === "preserved" && skippedExternalUuids.hasKey(box.address.uuid)) {return true}
            for (const [, targetAddress] of box.outgoingEdges()) {
                if (skippedExternalUuids.hasKey(targetAddress.uuid) && !targetAddress.isBox()) {return true}
            }
            return false
        }
        const sourceBoxes = clipboardGraph.boxes().filter(box => !shouldSkipBox(box))
        const typeCounts = new Map<string, number>()
        sourceBoxes.forEach(box => typeCounts.set(box.name, (typeCounts.get(box.name) ?? 0) + 1))
        console.debug("Clipboard paste:", [...typeCounts.entries()].map(([type, count]) => `${type}: ${count}`).join(", "))
        const uuidMap = UUID.newSet<UUIDMapper>(({source}) => source)
        sourceBoxes.forEach(box => {
            const isExternal = box.resource === "preserved"
            uuidMap.add({source: box.address.uuid, target: isExternal ? box.address.uuid : UUID.generate()})
        })
        skippedExternalUuids.forEach(uuid => uuidMap.add({source: uuid, target: uuid}))
        const result: Array<T> = []
        PointerField.decodeWith({
            map: (pointer, address) => {
                const remappedInternal = address.flatMap(addr =>
                    uuidMap.opt(addr.uuid).map(({target}) => addr.moveTo(target)))
                if (remappedInternal.nonEmpty()) {return remappedInternal}
                return options.mapPointer(pointer, address)
            }
        }, () => sourceBoxes.forEach(sourceBox => {
            const inputStream = new ByteArrayInput(sourceBox.toArrayBuffer())
            const targetUuid = uuidMap.get(sourceBox.address.uuid).target
            targetGraph.createBox(sourceBox.name as keyof BoxIO.TypeMap, targetUuid, box => {
                box.read(inputStream)
                options.modifyBox?.(box as T)
                result.push(box as T)
            })
        }))
        return result
    }
}