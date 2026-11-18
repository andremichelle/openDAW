import {ByteArrayInput, ByteArrayOutput, Func, int, isDefined, Option, panic, SortedSet, tryCatch, UUID} from "@opendaw/lib-std"
import {Address, Box, BoxGraph, PointerField} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {TransferUtils} from "@opendaw/studio-adapters"

// an openDAW device with every box it depends on, the State file of an exported device
export namespace DeviceState {
    const Magic = "openDAW:device-state"
    const Version: int = 1
    const HostPointerTypes: ReadonlySet<Pointers> = new Set([
        Pointers.InstrumentHost, Pointers.AudioEffectHost, Pointers.MIDIEffectHost, Pointers.MasteringHost])

    export interface Decoded {
        readonly device: Box
        readonly boxes: ReadonlyArray<Box>
    }

    export const boxesOf = (device: Box): ReadonlyArray<Box> => [device, ...TransferUtils.deviceDependencies(device)]

    // the project-wide boxes (root, timeline) a device may point into, matched by class when decoded
    export const encode = (device: Box, anchors: ReadonlyArray<Box>): ArrayBuffer => {
        const output = ByteArrayOutput.create()
        output.writeString(Magic)
        output.writeInt(Version)
        output.writeInt(anchors.length)
        anchors.forEach(anchor => {
            output.writeString(anchor.name)
            UUID.toDataOutput(output, anchor.address.uuid)
        })
        const boxes = boxesOf(device)
        output.writeInt(boxes.length)
        boxes.forEach(box => {
            output.writeString(box.name)
            UUID.toDataOutput(output, box.address.uuid)
            const bytes = box.toArrayBuffer()
            output.writeInt(bytes.byteLength)
            output.writeBytes(new Int8Array(bytes))
        })
        return output.toArrayBuffer() as ArrayBuffer
    }

    // what a user's session holds about a device, the exports before this one carried it along
    const UserStateBoxes: ReadonlySet<string> = new Set(["SelectionBox"])

    // the format of the exports before this one, the device first, no anchors
    const LegacyMagic = "openDAW:device"

    export const isDeviceState = (buffer: ArrayBufferLike): boolean => {
        const header = tryCatch(() => new ByteArrayInput(buffer).readString())
        return header.status === "success" && (header.value === Magic || header.value === LegacyMagic)
    }

    type Entry = { name: keyof BoxIO.TypeMap, uuid: UUID.Bytes, bytes: Int8Array }

    // the old format took the device's automation tracks and selection along, a scratch graph finds what it needs
    const dependenciesOnly = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => {
        const scratch = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        scratch.beginTransaction()
        const boxes = entries.map(({name, uuid, bytes}) =>
            scratch.createBox(name, uuid, box => box.read(new ByteArrayInput(bytes.buffer))))
        scratch.endTransaction()
        const needed = UUID.newSet<UUID.Bytes>(uuid => uuid)
        needed.addMany(boxesOf(boxes[0]).map(box => box.address.uuid))
        return entries.filter(({uuid}) => needed.hasKey(uuid))
    }

    const readEntries = (input: ByteArrayInput, anchors: SortedSet<UUID.Bytes, TransferUtils.UUIDMapper>,
                         targets: ReadonlyArray<Box>): ReadonlyArray<Entry> => {
        const magic = input.readString()
        const version = input.readInt()
        const readBytes = (): Int8Array => {
            const bytes = new Int8Array(input.readInt())
            input.readBytes(bytes)
            return bytes
        }
        if (magic === LegacyMagic && version === 1) {
            const readLegacy = (): Entry => {
                const uuid = UUID.fromDataInput(input)
                const name = input.readString() as keyof BoxIO.TypeMap
                return {name, uuid, bytes: readBytes()}
            }
            const device = readLegacy()
            const count = input.readInt()
            return dependenciesOnly([device, ...Array.from({length: count}, readLegacy)])
        }
        if (magic !== Magic) {return panic("Not an openDAW device state")}
        if (version !== Version) {return panic(`Unsupported device state version ${version}`)}
        const anchorCount = input.readInt()
        for (let index = 0; index < anchorCount; index++) {
            const name = input.readString()
            const source = UUID.fromDataInput(input)
            const target = targets.find(box => box.name === name)
            if (isDefined(target)) {anchors.add({source, target: target.address.uuid})}
        }
        const count = input.readInt()
        return Array.from({length: count}, (): Entry => {
            const name = input.readString() as keyof BoxIO.TypeMap
            const uuid = UUID.fromDataInput(input)
            return {name, uuid, bytes: readBytes()}
        })
    }

    // boxes keep their uuids unless taken, a resource that is already there is shared
    export const decode = (boxGraph: BoxGraph<BoxIO.TypeMap>,
                           buffer: ArrayBufferLike,
                           hostOf: Func<PointerField, Option<Address>>,
                           targets: ReadonlyArray<Box>): Decoded => {
        const anchors = UUID.newSet<TransferUtils.UUIDMapper>(({source}) => source)
        const entries = readEntries(new ByteArrayInput(buffer), anchors, targets)
            .filter(({name}) => !UserStateBoxes.has(name))
        if (entries.length === 0) {return panic("Empty device state")}
        const shared = UUID.newSet<UUID.Bytes>(uuid => uuid)
        const uuidMap = UUID.newSet<TransferUtils.UUIDMapper>(({source}) => source)
        entries.forEach(({uuid}, index) => {
            const existing = boxGraph.findBox(uuid).unwrapOrUndefined()
            if (!isDefined(existing)) {
                uuidMap.add({source: uuid, target: uuid})
            } else if (index > 0 && TransferUtils.keepsIdentity(existing)) {
                shared.add(uuid)
            } else {
                uuidMap.add({source: uuid, target: UUID.generate()})
            }
        })
        const created: Array<Box> = []
        PointerField.decodeWith({
            map: (pointer: PointerField, address: Option<Address>): Option<Address> => address.flatMap(target => {
                const mapped = uuidMap.opt(target.uuid)
                if (mapped.nonEmpty()) {return Option.wrap(target.moveTo(mapped.unwrap().target))}
                if (shared.hasKey(target.uuid)) {return Option.wrap(target)}
                const anchor = anchors.opt(target.uuid)
                if (anchor.nonEmpty()) {return Option.wrap(target.moveTo(anchor.unwrap().target))}
                if (HostPointerTypes.has(pointer.pointerType as Pointers)) {return hostOf(pointer)}
                if (boxGraph.findBox(target.uuid).nonEmpty()) {return Option.wrap(target)}
                return TransferUtils.mapRootPointer(pointer, boxGraph)
            })
        }, () => entries.forEach(({name, uuid, bytes}) => {
            if (shared.hasKey(uuid)) {return}
            const target = uuidMap.get(uuid, "device state uuid").target
            created.push(boxGraph.createBox(name, target, box => box.read(new ByteArrayInput(bytes.buffer))))
        }))
        const device = created[0]
        if (!isDefined(device)) {return panic("Device state without device")}
        return {device, boxes: created}
    }
}
