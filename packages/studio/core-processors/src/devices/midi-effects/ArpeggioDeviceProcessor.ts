import {ArpeggioDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {Event, EventSpanRetainer, Fraction, Fragmentor, NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {assert, Bits, Id, int, Option, Terminable, UUID} from "@moises-ai/lib-std"
import {EngineContext} from "../../EngineContext"
import {EventProcessor} from "../../EventProcessor"
import {Block, BlockFlag, Processor} from "../../processing"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteEventTarget, NoteLifecycleEvent} from "../../NoteEventSource"
import {ArpeggioModes, Mode, VelocityMatrix} from "./ArpeggioDevice/ArpeggioModes"

import {MidiEffectProcessor} from "../../MidiEffectProcessor"

export class ArpeggioDeviceProcessor extends EventProcessor implements MidiEffectProcessor {
    readonly #adapter: ArpeggioDeviceBoxAdapter

    readonly #stack: Array<NoteEvent>
    readonly #retainer: EventSpanRetainer<Id<NoteEvent>>

    readonly #modeIndexParameter: AutomatableParameter<int>
    readonly #rateParameter: AutomatableParameter<int>
    readonly #gateParameter: AutomatableParameter<number>
    readonly #repeatParameter: AutomatableParameter<int>
    readonly #numOctaveParameter: AutomatableParameter<int>
    readonly #velocityParameter: AutomatableParameter<int>

    readonly #velocityMatrix: VelocityMatrix = VelocityMatrix.create()

    #source: Option<NoteEventSource> = Option.None

    #strategy: Mode = ArpeggioModes[0]
    #rate: ppqn = NaN
    #gate: number = 1.0
    #repeat: int = 1
    #numOctaves: int = 1

    constructor(context: EngineContext, adapter: ArpeggioDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter

        this.#stack = []
        this.#retainer = new EventSpanRetainer<Id<NoteEvent>>()

        this.#modeIndexParameter = this.own(this.bindParameter(adapter.namedParameter.modeIndex))
        this.#rateParameter = this.own(this.bindParameter(adapter.namedParameter.rate))
        this.#gateParameter = this.own(this.bindParameter(adapter.namedParameter.gate))
        this.#repeatParameter = this.own(this.bindParameter(adapter.namedParameter.repeat))
        this.#numOctaveParameter = this.own(this.bindParameter(adapter.namedParameter.numOctaves))
        this.#velocityParameter = this.own(this.bindParameter(adapter.namedParameter.velocity))

        this.ownAll(context.registerProcessor(this))
        this.readAllParameters()
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}
    get noteEventTarget(): Option<NoteEventTarget> {return Option.wrap(this)}

    setNoteEventSource(source: NoteEventSource): Terminable {
        assert(this.#source.isEmpty(), "NoteEventSource already set")
        this.#source = Option.wrap(source)
        return Terminable.create(() => this.#source = Option.None)
    }

    * processNotes(from: ppqn, to: ppqn, flags: int): IterableIterator<NoteLifecycleEvent> {
        if (this.#retainer.nonEmpty()) {
            const releaseAll = Bits.every(flags, BlockFlag.discontinuous)
            if (releaseAll) {
                for (const event of this.#retainer.releaseAll()) {
                    yield NoteLifecycleEvent.stop(event, from)
                }
            } else {
                for (const event of this.#retainer.releaseLinearCompleted(to)) {
                    yield NoteLifecycleEvent.stop(event, event.position + event.duration)
                }
            }
        }
        if (this.#source.nonEmpty()) {
            const source = this.#source.unwrap()
            for (const _ of source.processNotes(from, to, flags)) {} // advance source
            const onlyExternal = !Bits.every(flags, BlockFlag.transporting)
            for (const {position, index} of Fragmentor.iterateWithIndex(from, to, this.#rate)) {
                const stack = Array.from(source.iterateActiveNotesAt(position, onlyExternal))
                if (stack.length === 0) {continue}
                const stepIndex = Math.floor(index / this.#repeat)
                const duration = Math.max(1, Math.floor(this.#rate * this.#gate))
                const event = this.#strategy.run(stack, this.#numOctaves, stepIndex, position, duration, this.#velocityMatrix)
                this.#retainer.addAndRetain({...event})
                yield event
            }
            for (const event of this.#retainer.releaseLinearCompleted(to)) {
                yield NoteLifecycleEvent.stop(event, event.position + event.duration)
            }
        }
    }

    * iterateActiveNotesAt(position: ppqn, onlyExternal: boolean): IterableIterator<NoteEvent> {
        if (this.#source.isEmpty() || onlyExternal) {return}
        yield* this.#retainer.overlapping(position, NoteEvent.Comparator)
    }

    reset(): void {
        this.#stack.length = 0
        this.#retainer.clear()
        this.eventInput.clear()
    }

    processEvents(_block: Block, _from: ppqn, _to: ppqn): void {}

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.#modeIndexParameter) {
            this.#strategy = ArpeggioModes.at(this.#modeIndexParameter.getValue()) ?? ArpeggioModes[0]
        } else if (parameter === this.#rateParameter) {
            this.#rate = Fraction.toPPQN(ArpeggioDeviceBoxAdapter.RateFractions[this.#rateParameter.getValue()])
        } else if (parameter === this.#gateParameter) {
            this.#gate = this.#gateParameter.getValue()
        } else if (parameter === this.#repeatParameter) {
            this.#repeat = this.#repeatParameter.getValue()
        } else if (parameter === this.#numOctaveParameter) {
            this.#numOctaves = this.#numOctaveParameter.getValue()
        } else if (parameter === this.#velocityParameter) {
            const velocity = this.#velocityParameter.getValue()
            if (velocity <= 0.0) {
                this.#velocityMatrix.add = 1.0 + velocity
                this.#velocityMatrix.mult = 0.0
            } else {
                this.#velocityMatrix.add = 1.0 - velocity
                this.#velocityMatrix.mult = velocity
            }
        }
    }

    handleEvent(_block: Block, _event: Event): void {}

    index(): number {return this.#adapter.indexField.getValue()}
    adapter(): ArpeggioDeviceBoxAdapter {return this.#adapter}
}