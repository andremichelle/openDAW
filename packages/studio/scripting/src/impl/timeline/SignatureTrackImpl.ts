import {SignatureEventBox, TimelineBox} from "@opendaw/studio-boxes"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {Validator} from "@opendaw/studio-adapters"
import {asInstanceOf, int, panic, UUID} from "@opendaw/lib-std"
import {SignatureEvent, SignatureTrack} from "../../Api"
import {Context} from "../Context"
import {Facade} from "../Common"
import {Fields} from "../Fields"
import {Guard} from "../Guard"

export class SignatureEventImpl extends Facade<SignatureEventBox> implements SignatureEvent {
    static wrap(context: Context, track: SignatureTrackImpl, box: SignatureEventBox): SignatureEventImpl {
        return context.facade(box, () => new SignatureEventImpl(context, track, box))
    }

    readonly #track: SignatureTrackImpl
    declare relativePosition: int
    declare numerator: int
    declare denominator: int

    private constructor(context: Context, track: SignatureTrackImpl, box: SignatureEventBox) {
        super(context, box)
        this.#track = track
        this.bind({relativePosition: box.relativePosition, numerator: box.nominator, denominator: box.denominator})
    }

    get index(): int {return this.box.index.getValue()}
    get position(): ppqn {return this.#track.positionOf(this)}

    remove(): void {this.#track.removeEvent(this)}
}

export class SignatureTrackImpl implements SignatureTrack {
    readonly #context: Context
    readonly #timelineBox: TimelineBox

    declare enabled: boolean

    constructor(context: Context, timelineBox: TimelineBox) {
        this.#context = context
        this.#timelineBox = timelineBox
        Fields.bind(context, this, {enabled: timelineBox.signatureTrack.enabled}, "signatureTrack.")
    }

    get events(): ReadonlyArray<SignatureEventImpl> {
        return this.#timelineBox.signatureTrack.events.pointerHub.incoming()
            .map(({box}) => SignatureEventImpl.wrap(this.#context, this, asInstanceOf(box, SignatureEventBox)))
            .sort((a, b) => a.index - b.index)
    }

    positionOf(event: SignatureEventImpl): ppqn {
        const {position} = this.#iterate().find(entry => entry.event === event) ?? panic("event not found")
        return position
    }

    addEvent(position: ppqn, numerator: int, denominator: int): SignatureEventImpl {
        const validatedPosition = Guard.int32("non-negative", position, "position")
        const [validatedNumerator, validatedDenominator] = Validator.isTimeSignatureValid(
            Guard.integer(numerator, "numerator"), Guard.integer(denominator, "denominator"))
            .result()
        return this.#context.edit(() => {
            const entries = this.#iterate()
            let previous = {position: 0, numerator: this.#timelineBox.signature.nominator.getValue(), denominator: this.#timelineBox.signature.denominator.getValue(), index: -1}
            let insertAfter = 0
            entries.forEach((entry, entryIndex) => {
                if (entry.position > validatedPosition) {return}
                previous = {position: entry.position, numerator: entry.numerator, denominator: entry.denominator, index: entry.event.index}
                insertAfter = entryIndex + 1
            })
            const previousBar = PPQN.fromSignature(previous.numerator, previous.denominator)
            const relativePosition = Math.max(1, Math.round((validatedPosition - previous.position) / previousBar))
            const newPosition = previous.position + relativePosition * previousBar
            const newBar = PPQN.fromSignature(validatedNumerator, validatedDenominator)
            const successors = entries.slice(insertAfter)
            successors.forEach(({event, position}, successorIndex) => {
                event.box.index.setValue(event.index + 1)
                if (successorIndex === 0) {
                    event.box.relativePosition.setValue(Math.max(1, Math.round((position - newPosition) / newBar)))
                }
            })
            const box = SignatureEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.index.setValue(previous.index + 1)
                box.relativePosition.setValue(relativePosition)
                box.nominator.setValue(validatedNumerator)
                box.denominator.setValue(validatedDenominator)
                box.events.refer(this.#timelineBox.signatureTrack.events)
            })
            return SignatureEventImpl.wrap(this.#context, this, box)
        })
    }

    removeEvent(event: SignatureEventImpl): void {
        this.#context.edit(() => {
            const entries = this.#iterate()
            const entryIndex = entries.findIndex(entry => entry.event === event)
            if (entryIndex === -1) {return}
            const successors = entries.slice(entryIndex + 1)
            const previous = entryIndex > 0 ? entries[entryIndex - 1] : null
            const previousPosition = previous?.position ?? 0
            const previousBar = previous === null
                ? PPQN.fromSignature(this.#timelineBox.signature.nominator.getValue(), this.#timelineBox.signature.denominator.getValue())
                : PPQN.fromSignature(previous.numerator, previous.denominator)
            event.box.delete()
            let accumulated = previousPosition
            let bar = previousBar
            successors.forEach(({event: successor, position, numerator, denominator}) => {
                const relativePosition = Math.max(1, Math.round((position - accumulated) / bar))
                successor.box.relativePosition.setValue(relativePosition)
                successor.box.index.setValue(successor.index - 1)
                accumulated += relativePosition * bar
                bar = PPQN.fromSignature(numerator, denominator)
            })
        })
    }

    clearEvents(): void {this.#context.edit(() => this.events.forEach(event => event.box.delete()))}

    #iterate(): ReadonlyArray<{ event: SignatureEventImpl, position: ppqn, numerator: int, denominator: int }> {
        let position: ppqn = 0
        let numerator = this.#timelineBox.signature.nominator.getValue()
        let denominator = this.#timelineBox.signature.denominator.getValue()
        return this.events.map(event => {
            position += PPQN.fromSignature(numerator, denominator) * event.relativePosition
            numerator = event.numerator
            denominator = event.denominator
            return {event, position, numerator, denominator}
        })
    }
}
