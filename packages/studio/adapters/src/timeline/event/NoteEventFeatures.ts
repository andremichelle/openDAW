import {asInstanceOf, bipolar, int, Option, Procedure, SortedSet, unitValue, UUID} from "@opendaw/lib-std"
import {NoteEventBox, NoteEventChanceBox, NoteEventGroupBox, NoteEventRepeatBox} from "@opendaw/studio-boxes"

export namespace NoteEventFeatures {
    export const GroupMode = {PlayAll: 0, PlayOne: 1} as const
    export type GroupMode = typeof GroupMode[keyof typeof GroupMode]

    export type GroupMapping = SortedSet<UUID.Bytes, { source: UUID.Bytes, target: NoteEventGroupBox }>

    export type Values = {
        readonly chance: int
        readonly group: Option<NoteEventGroupBox>
        readonly playCount: int
        readonly playCurve: bipolar
        readonly repeatLength: unitValue
        readonly velocityFade: bipolar
    }

    export type CopyOptions = {
        readonly split: boolean
        readonly groups: GroupMapping
    }

    export const createGroupMapping = (): GroupMapping => UUID.newSet(entry => entry.source)

    export const chanceBox = (note: NoteEventBox): Option<NoteEventChanceBox> =>
        Option.wrap(note.random.pointerHub.incoming().at(0)?.box).map(box => asInstanceOf(box, NoteEventChanceBox))

    export const repeatBox = (note: NoteEventBox): Option<NoteEventRepeatBox> =>
        Option.wrap(note.split.pointerHub.incoming().at(0)?.box).map(box => asInstanceOf(box, NoteEventRepeatBox))

    export const groupBox = (note: NoteEventBox): Option<NoteEventGroupBox> =>
        note.group.targetVertex.map(vertex => asInstanceOf(vertex.box, NoteEventGroupBox))

    export const readChance = (note: NoteEventBox): int => groupBox(note).match({
        none: () => chanceBox(note).mapOr(box => box.chance.getValue(), 100),
        some: group => group.chance.getValue()
    })
    export const readPlayCount = (note: NoteEventBox): int => repeatBox(note).mapOr(box => box.count.getValue(), 1)
    export const readPlayCurve = (note: NoteEventBox): bipolar => repeatBox(note).mapOr(box => box.curve.getValue(), 0.0)
    export const readRepeatLength = (note: NoteEventBox): unitValue =>
        repeatBox(note).mapOr(box => box.length.getValue(), 1.0)
    export const readVelocityFade = (note: NoteEventBox): bipolar =>
        repeatBox(note).mapOr(box => box.velocityFade.getValue(), 0.0)

    export const read = (note: NoteEventBox): Values => ({
        chance: readChance(note),
        group: groupBox(note),
        playCount: readPlayCount(note),
        playCurve: readPlayCurve(note),
        repeatLength: readRepeatLength(note),
        velocityFade: readVelocityFade(note)
    })

    export const velocityGain = (fade: bipolar, index: int, count: int): unitValue => {
        const ratio = count > 1 ? index / (count - 1) : 0.0
        return fade < 0.0 ? 1.0 + fade * ratio : 1.0 - fade * (1.0 - ratio)
    }

    const ensureChanceBox = (note: NoteEventBox): NoteEventChanceBox => chanceBox(note).match({
        none: () => NoteEventChanceBox.create(note.graph, UUID.generate(), box => box.event.refer(note.random)),
        some: box => box
    })

    const ensureRepeatBox = (note: NoteEventBox): NoteEventRepeatBox => repeatBox(note).match({
        none: () => NoteEventRepeatBox.create(note.graph, UUID.generate(), box => box.event.refer(note.split)),
        some: box => box
    })

    export const writeChance = (note: NoteEventBox, value: int): void => groupBox(note).match({
        none: () => {
            if (value === 100) {
                clearRandom(note)
            } else {
                ensureChanceBox(note).chance.setValue(value)
            }
        },
        some: group => group.chance.setValue(value)
    })

    const isDefaultRepeat = (box: NoteEventRepeatBox): boolean => box.count.getValue() === 1
        && box.curve.getValue() === 0.0 && box.length.getValue() === 1.0 && box.velocityFade.getValue() === 0.0

    const writeRepeat = (note: NoteEventBox, write: Procedure<NoteEventRepeatBox>, isDefault: boolean): void => {
        if (isDefault && repeatBox(note).isEmpty()) {return}
        const box = ensureRepeatBox(note)
        write(box)
        if (isDefaultRepeat(box)) {box.delete()}
    }

    export const writePlayCount = (note: NoteEventBox, value: int): void =>
        writeRepeat(note, box => box.count.setValue(value), value === 1)
    export const writePlayCurve = (note: NoteEventBox, value: bipolar): void =>
        writeRepeat(note, box => box.curve.setValue(value), value === 0.0)
    export const writeRepeatLength = (note: NoteEventBox, value: unitValue): void =>
        writeRepeat(note, box => box.length.setValue(value), value === 1.0)
    export const writeVelocityFade = (note: NoteEventBox, value: bipolar): void =>
        writeRepeat(note, box => box.velocityFade.setValue(value), value === 0.0)

    export const clearRandom = (note: NoteEventBox): void => chanceBox(note).ifSome(box => box.delete())
    export const clearSplit = (note: NoteEventBox): void => repeatBox(note).ifSome(box => box.delete())

    const collectGroups = (notes: ReadonlyArray<NoteEventBox>): ReadonlyArray<NoteEventGroupBox> => {
        const groups = UUID.newSet<NoteEventGroupBox>(group => group.address.uuid)
        notes.forEach(note => groupBox(note).ifSome(group => groups.add(group)))
        return groups.values()
    }

    const deleteIfEmpty = (group: NoteEventGroupBox): void => {
        if (group.isAttached() && group.pointerHub.isEmpty()) {group.delete()}
    }

    export const group = (notes: ReadonlyArray<NoteEventBox>, mode: GroupMode): Option<NoteEventGroupBox> => {
        if (notes.length === 0) {return Option.None}
        const earliest = notes.reduce((first, note) => {
            const delta = note.position.getValue() - first.position.getValue()
            return delta < 0 || (delta === 0 && note.pitch.getValue() < first.pitch.getValue()) ? note : first
        })
        const chance = readChance(earliest)
        const previous = collectGroups(notes)
        const target = NoteEventGroupBox.create(notes[0].graph, UUID.generate(), box => {
            box.chance.setValue(chance)
            box.mode.setValue(mode)
        })
        notes.forEach(note => {
            clearRandom(note)
            note.group.refer(target)
        })
        previous.forEach(deleteIfEmpty)
        return Option.wrap(target)
    }

    export const leaveGroup = (notes: ReadonlyArray<NoteEventBox>): void => {
        const previous = collectGroups(notes)
        notes.forEach(note => note.group.defer())
        previous.forEach(deleteIfEmpty)
    }

    export const ungroup = (notes: ReadonlyArray<NoteEventBox>): void =>
        collectGroups(notes).forEach(group => group.delete())

    export const copy = (source: NoteEventBox, target: NoteEventBox, {split, groups}: CopyOptions): void => {
        groupBox(source).ifSome(sourceGroup => target.group.refer(groups.getOrCreate(sourceGroup.address.uuid, uuid => ({
            source: uuid,
            target: NoteEventGroupBox.create(target.graph, UUID.generate(), box => {
                box.chance.setValue(sourceGroup.chance.getValue())
                box.mode.setValue(sourceGroup.mode.getValue())
            })
        })).target))
        chanceBox(source).ifSome(sourceBox => NoteEventChanceBox.create(target.graph, UUID.generate(), box => {
            box.event.refer(target.random)
            box.chance.setValue(sourceBox.chance.getValue())
        }))
        if (!split) {return}
        repeatBox(source).ifSome(sourceBox => NoteEventRepeatBox.create(target.graph, UUID.generate(), box => {
            box.event.refer(target.split)
            box.count.setValue(sourceBox.count.getValue())
            box.curve.setValue(sourceBox.curve.getValue())
            box.length.setValue(sourceBox.length.getValue())
            box.velocityFade.setValue(sourceBox.velocityFade.getValue())
        }))
    }
}
