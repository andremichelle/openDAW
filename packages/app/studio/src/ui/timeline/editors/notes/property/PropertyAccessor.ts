import {StringMapping, unitValue, ValueMapping} from "@moises-ai/lib-std"
import {PropertyParameters} from "@/ui/timeline/editors/notes/property/PropertyParameters.ts"
import {NoteModifyStrategy} from "@/ui/timeline/editors/notes/NoteModifyStrategies.ts"
import {NoteEventBox} from "@moises-ai/studio-boxes"
import {UINoteEvent} from "../UINoteEvent"

export interface PropertyAccessor {
    get label(): string
    get minmaxLabels(): [string, string]
    get anchor(): unitValue
    get valueMapping(): ValueMapping<number>
    get stringMapping(): StringMapping<number>
    readRawValue(note: UINoteEvent): number
    readValue(strategy: NoteModifyStrategy, note: UINoteEvent): number
    writeValue(box: NoteEventBox, value: number): void
}

export const NotePropertyVelocity = new class implements PropertyAccessor {
    readonly label = "Velocity"
    readonly minmaxLabels: [string, string] = ["0%", "100%"]
    readonly anchor: number = 0.0
    readonly valueMapping: ValueMapping<number> = PropertyParameters.velocity.parameter.valueMapping
    readonly stringMapping: StringMapping<number> = PropertyParameters.velocity.parameter.stringMapping

    readRawValue(note: UINoteEvent): number {return note.velocity}
    readValue(strategy: NoteModifyStrategy, note: UINoteEvent): number {return strategy.readVelocity(note)}
    writeValue(box: NoteEventBox, value: number): void {box.velocity.setValue(value)}
}

export const NotePropertyCent = new class implements PropertyAccessor {
    readonly label = "Cent"
    readonly minmaxLabels: [string, string] = ["-50ct", "+50ct"]
    readonly anchor: number = 0.5
    readonly valueMapping: ValueMapping<number> = PropertyParameters.cent.parameter.valueMapping
    readonly stringMapping: StringMapping<number> = PropertyParameters.cent.parameter.stringMapping

    readRawValue(note: UINoteEvent): number {return note.cent}
    readValue(strategy: NoteModifyStrategy, note: UINoteEvent): number {return strategy.readCent(note)}
    writeValue(box: NoteEventBox, value: number): void {box.cent.setValue(value)}
}

export const NotePropertyChance = new class implements PropertyAccessor {
    readonly label = "Chance"
    readonly minmaxLabels: [string, string] = ["1%", "100%"]
    readonly anchor: number = 0.0
    readonly valueMapping: ValueMapping<number> = PropertyParameters.chance.parameter.valueMapping
    readonly stringMapping: StringMapping<number> = PropertyParameters.chance.parameter.stringMapping

    readRawValue(note: UINoteEvent): number {return note.chance}
    readValue(strategy: NoteModifyStrategy, note: UINoteEvent): number {return strategy.readChance(note)}
    writeValue(box: NoteEventBox, value: number): void {box.chance.setValue(value)}
}

export const NotePropertyAccessors = [NotePropertyVelocity, NotePropertyCent, NotePropertyChance]