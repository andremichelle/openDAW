import {Editing, int, isDefined, Lifecycle, Optional, MutableObservableValue, ObservableValue, Observer, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Int32Field} from "@opendaw/lib-box"
import {SamplerModulationBox} from "@opendaw/studio-boxes"
import {SamplerDeviceBoxAdapter, SamplerModulation, SamplerModulationBoxAdapter} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {DropDown} from "@/ui/composite/DropDown"
import {SamplerValueLabel} from "./SamplerValueLabel"

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: SamplerDeviceBoxAdapter
    // a slot is hovered or left
    onHover: (source: int, target: int, enabled: boolean) => void
}

const editable = (editing: Editing, field: Int32Field): MutableObservableValue<int> =>
    new class implements MutableObservableValue<int> {
        getValue(): int {return field.getValue()}
        setValue(value: int): void {editing.modify(() => field.setValue(value))}
        subscribe(observer: Observer<ObservableValue<int>>): Subscription {return field.subscribe(() => observer(this))}
        catchupAndSubscribe(observer: Observer<ObservableValue<int>>): Subscription {
            observer(this)
            return this.subscribe(observer)
        }
    }

// a typed amount in the unit the target shows: cents or semitones for pitch, octaves for a rate, percent else
const parseAmount = (target: int, text: string): Optional<number> => {
    const value = SamplerValueLabel.numberIn(text)
    if (!isDefined(value)) {return undefined}
    if (target === SamplerModulation.Target.Pitch) {
        return (/st/i.test(text) ? value : value / 100) / SamplerModulation.PitchRange
    }
    if (target === SamplerModulation.Target.LfoARate || target === SamplerModulation.Target.LfoBRate) {
        return value / SamplerModulation.RateRange
    }
    return value / 100
}

const PitchStep = 5 / 100 / SamplerModulation.PitchRange // five cents

const printAmount = (target: int, amount: number): SamplerValueLabel.Printed => {
    if (target === SamplerModulation.Target.Pitch) {
        const semitones = amount * SamplerModulation.PitchRange
        return Math.abs(semitones) < 1.0 ? [String(Math.round(semitones * 100)), "ct"] : [semitones.toFixed(1), "st"]
    }
    if (target === SamplerModulation.Target.LfoARate || target === SamplerModulation.Target.LfoBRate) {
        return [(amount * SamplerModulation.RateRange).toFixed(2), "oct"]
    }
    return [String(Math.round(amount * 100)), "%"]
}

// The modulation slots of a Sampler: each a source, a target and an amount, added and removed by the user.
export const SamplerModulationList = ({lifecycle, editing, adapter, onHover}: Construct) => {
    const add: HTMLElement = (
        <div className="add" onclick={() => editing.modify(() => {
            const {box} = adapter
            SamplerModulationBox.create(box.graph, UUID.generate(), slot => {
                slot.device.refer(box.modulations)
                slot.index.setValue(adapter.modulations.adapters()
                    .reduce((highest, entry) => Math.max(highest, entry.indexField.getValue() + 1), 0))
            })
        })}><Icon symbol={IconSymbol.Add}/></div>
    )
    const rows: HTMLElement = <div className="rows">{add}</div>
    const entries = UUID.newSet<{ uuid: UUID.Bytes, row: HTMLElement, terminator: Terminator }>(entry => entry.uuid)
    const order = (): void => adapter.modulations.adapters()
        .forEach(slot => entries.opt(slot.uuid).ifSome(({row}) => rows.insertBefore(row, add)))
    const create = (slot: SamplerModulationBoxAdapter): void => {
        const terminator = new Terminator()
        const {box} = slot
        const hover = (enabled: boolean): void => onHover(box.source.getValue(), box.target.getValue(), enabled)
        const chooser = (field: Int32Field, names: ReadonlyArray<string>) => (
            <DropDown lifecycle={terminator} owner={editable(editing, field)} provider={() => names.map((_, index) => index)}
                      mapping={index => names[index]} appearance={{color: Colors.dark, activeColor: Colors.gray}}/>
        )
        const row: HTMLElement = (
            <div className="slot" onpointerenter={() => hover(true)} onpointerleave={() => hover(false)}>
                {chooser(box.source, SamplerModulation.SourceNames)}
                {chooser(box.target, SamplerModulation.TargetNames)}
                {SamplerValueLabel.create(terminator, editing,
                    update => Terminable.many(box.amount.subscribe(() => update()), box.target.subscribe(() => update())), {
                        name: "Amount", min: -1.0, max: 1.0,
                        get step(): number {return box.target.getValue() === SamplerModulation.Target.Pitch ? PitchStep : 0.01},
                        print: amount => printAmount(box.target.getValue(), amount),
                        parse: text => parseAmount(box.target.getValue(), text),
                        get: () => box.amount.getValue(),
                        set: amount => box.amount.setValue(amount)
                    })}
                <div className="remove" onclick={() => {
                    hover(false)
                    editing.modify(() => box.delete())
                }}><Icon symbol={IconSymbol.Close}/></div>
            </div>
        )
        entries.add({uuid: slot.uuid, row, terminator})
    }
    lifecycle.ownAll(
        adapter.modulations.catchupAndSubscribe({
            onAdd: slot => {
                create(slot)
                order()
            },
            onRemove: slot => {
                const {row, terminator} = entries.removeByKey(slot.uuid)
                terminator.terminate()
                row.remove()
            },
            onReorder: () => order()
        }),
        {terminate: () => entries.forEach(({terminator}) => terminator.terminate())}
    )
    return (
        <div className="modulation">
            <div className="label">Source</div>
            <div className="label">Target</div>
            <div className="label">Amount</div>
            {rows}
        </div>
    )
}
