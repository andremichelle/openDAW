import {ByteArrayInput, ByteArrayOutput, Option, Predicate, UUID} from "@opendaw/lib-std"
import {Address, Box, BoxGraph, PointerField} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"

type UUIDMapper = { source: UUID.Bytes, target: UUID.Bytes }

export namespace ClipboardUtils {
    export const serializeBoxes = (boxes: ReadonlyArray<Box>, metadata: ArrayBufferLike = new ArrayBuffer(0)): ArrayBufferLike => {
        const typeCounts = new Map<string, number>()
        boxes.forEach(box => typeCounts.set(box.name, (typeCounts.get(box.name) ?? 0) + 1))
        console.debug("Clipboard copy:", [...typeCounts.entries()].map(([type, count]) => `${type}: ${count}`).join(", "))
        const clipboardGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const uuidMap = UUID.newSet<UUIDMapper>(({source}) => source)
        boxes.forEach(box => uuidMap.add({source: box.address.uuid, target: UUID.generate()}))
        clipboardGraph.beginTransaction()
        PointerField.decodeWith({
            map: (_pointer: PointerField, address: Option<Address>): Option<Address> =>
                address.flatMap(addr => uuidMap.opt(addr.uuid).map(({target}) => addr.moveTo(target)))
        }, () => {
            boxes.forEach(sourceBox => {
                const input = new ByteArrayInput(sourceBox.toArrayBuffer())
                const targetUuid = uuidMap.get(sourceBox.address.uuid).target
                clipboardGraph.createBox(sourceBox.name as keyof BoxIO.TypeMap, targetUuid, box => box.read(input))
            })
        })
        clipboardGraph.endTransaction()
        const graphData = clipboardGraph.toArrayBuffer()
        const output = ByteArrayOutput.create()
        output.writeInt(metadata.byteLength)
        output.writeBytes(new Int8Array(metadata))
        output.writeInt(graphData.byteLength)
        output.writeBytes(new Int8Array(graphData))
        return output.toArrayBuffer()
    }

    export const deserializeBoxes = <T extends Box>(data: ArrayBufferLike,
                                                    targetGraph: BoxGraph,
                                                    options: {
                                                        mapPointer: (pointer: PointerField, address: Option<Address>) => Option<Address>
                                                        modifyBox?: (box: T) => void
                                                        excludeBox?: Predicate<Box>
                                                    }
    ): { metadata: ArrayBufferLike, boxes: ReadonlyArray<T> } => {
        const input = new ByteArrayInput(data)
        const metadataLength = input.readInt()
        const metadataBytes = new Int8Array(metadataLength)
        input.readBytes(metadataBytes)
        const graphDataLength = input.readInt()
        const graphData = new Int8Array(graphDataLength)
        input.readBytes(graphData)
        const clipboardGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        clipboardGraph.fromArrayBuffer(graphData.buffer)
        const sourceBoxes = clipboardGraph.boxes().filter(box => !options.excludeBox?.(box))
        const typeCounts = new Map<string, number>()
        sourceBoxes.forEach(box => typeCounts.set(box.name, (typeCounts.get(box.name) ?? 0) + 1))
        console.debug("Clipboard paste:", [...typeCounts.entries()].map(([type, count]) => `${type}: ${count}`).join(", "))
        const uuidMap = UUID.newSet<UUIDMapper>(({source}) => source)
        sourceBoxes.forEach(box => uuidMap.add({source: box.address.uuid, target: UUID.generate()}))
        const result: T[] = []
        PointerField.decodeWith({
            map: (pointer: PointerField, address: Option<Address>): Option<Address> => {
                const remappedInternal = address.flatMap(addr =>
                    uuidMap.opt(addr.uuid).map(({target}) => addr.moveTo(target)))
                if (remappedInternal.nonEmpty()) {return remappedInternal}
                return options.mapPointer(pointer, address)
            }
        }, () => {
            sourceBoxes.forEach(sourceBox => {
                const inputStream = new ByteArrayInput(sourceBox.toArrayBuffer())
                const targetUuid = uuidMap.get(sourceBox.address.uuid).target
                targetGraph.createBox(sourceBox.name as keyof BoxIO.TypeMap, targetUuid, box => {
                    box.read(inputStream)
                    options.modifyBox?.(box as T)
                    result.push(box as T)
                })
            })
        })
        return {metadata: metadataBytes.buffer, boxes: result}
    }
}
