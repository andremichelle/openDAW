import {Box, Field, PointerTypes, StringField} from "@opendaw/lib-box"
import {AudioFileBox, WerkstattParameterBox, WerkstattSampleBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {ParamDeclaration, SampleDeclaration, ScriptDeclaration} from "@opendaw/studio-adapters"
import {asInstanceOf, float, int, isDefined, isNull, Nullable, panic, UUID} from "@opendaw/lib-std"
import {Sample, ScriptParameter, ScriptSample} from "../../Api"
import {Context} from "../Context"
import {Accessors, Facade} from "../Common"
import {Guard} from "../Guard"
import {AudioFiles} from "../AudioFiles"

export type ScriptDeviceBox = Box & {
    readonly code: StringField<PointerTypes>
    readonly label: StringField<PointerTypes>
    readonly parameters: Field<Pointers.Parameter>
    readonly samples: Field<Pointers.Sample>
}

const COMPILER_VERSION = 1

export class ScriptParameterImpl extends Facade<WerkstattParameterBox> implements ScriptParameter {
    static wrap(context: Context, box: WerkstattParameterBox): ScriptParameterImpl {
        return context.facade(box, () => new ScriptParameterImpl(context, box))
    }

    declare value: float

    private constructor(context: Context, box: WerkstattParameterBox) {
        super(context, box)
        this.bind({value: box.value})
    }

    get label(): string {return this.box.label.getValue()}
    get index(): int {return this.box.index.getValue()}
    get defaultValue(): float {return this.box.defaultValue.getValue()}
}

export class ScriptSampleImpl extends Facade<WerkstattSampleBox> implements ScriptSample {
    static wrap(context: Context, box: WerkstattSampleBox): ScriptSampleImpl {
        return context.facade(box, () => new ScriptSampleImpl(context, box))
    }

    private constructor(context: Context, box: WerkstattSampleBox) {super(context, box)}

    get label(): string {return this.box.label.getValue()}
    get index(): int {return this.box.index.getValue()}
    get sample(): Nullable<Sample> {
        const fileBox = Accessors.pointerBox(this.box.file, AudioFileBox)
        return isNull(fileBox) ? null : AudioFiles.toSample(this.context, fileBox)
    }
    set sample(value: Nullable<Sample>) {
        AudioFiles.assign(this.context, this.box.file, () => isNull(value) ? null : AudioFiles.use(this.context, value))
    }
}

export class ScriptSupport {
    readonly #context: Context
    readonly #box: ScriptDeviceBox
    readonly #headerPattern: RegExp
    readonly #headerTag: string

    constructor(context: Context, box: ScriptDeviceBox, headerTag: string) {
        this.#context = context
        this.#box = box
        this.#headerTag = headerTag
        this.#headerPattern = new RegExp(`^// @${headerTag} (\\w+) (\\d+) (\\d+)\n`)
    }

    get code(): string {return this.#parse(this.#box.code.getValue()).userCode}

    set code(source: string) {
        const userCode = this.#parse(Guard.string(source, "code")).userCode
        const params = ScriptDeclaration.parseParams(userCode)
        const samples = ScriptDeclaration.parseSamples(userCode)
        const order = ScriptDeclaration.parseDeclarationOrder(userCode)
        const label = ScriptDeclaration.parseLabel(userCode)
        const update = this.#parse(this.#box.code.getValue()).update + 1
        this.#context.edit(() => {
            this.#box.code.setValue(`// @${this.#headerTag} js ${COMPILER_VERSION} ${update}\n${userCode}`)
            label.ifSome(name => this.#box.label.setValue(name))
            this.#reconcileParameters(params, order)
            this.#reconcileSamples(samples, order)
        })
    }

    get parameters(): ReadonlyArray<ScriptParameterImpl> {
        return this.#box.parameters.pointerHub.incoming()
            .map(({box}) => ScriptParameterImpl.wrap(this.#context, asInstanceOf(box, WerkstattParameterBox)))
            .sort((a, b) => a.index - b.index)
    }

    get samples(): ReadonlyArray<ScriptSampleImpl> {
        return this.#box.samples.pointerHub.incoming()
            .map(({box}) => ScriptSampleImpl.wrap(this.#context, asInstanceOf(box, WerkstattSampleBox)))
            .sort((a, b) => a.index - b.index)
    }

    parameter(label: string): ScriptParameterImpl {
        return this.parameters.find(parameter => parameter.label === label)
            ?? panic(new RangeError(`No parameter '${label}' declared. Available: ${this.parameters.map(parameter => parameter.label).join(", ")}`))
    }

    sample(label: string): ScriptSampleImpl {
        return this.samples.find(sample => sample.label === label)
            ?? panic(new RangeError(`No sample '${label}' declared. Available: ${this.samples.map(sample => sample.label).join(", ")}`))
    }

    #parse(source: string): { userCode: string, update: int } {
        const match = source.match(this.#headerPattern)
        return isDefined(match)
            ? {userCode: source.slice(match[0].length), update: parseInt(match[3])}
            : {userCode: source, update: 0}
    }

    #reconcileParameters(declared: ReadonlyArray<ParamDeclaration>, order: Map<string, number>): void {
        const existing = new Map<string, WerkstattParameterBox>()
        this.#box.parameters.pointerHub.incoming().forEach(({box}) => {
            const paramBox = asInstanceOf(box, WerkstattParameterBox)
            existing.set(paramBox.label.getValue(), paramBox)
        })
        const declaredLabels = new Set(declared.map(({label}) => label))
        existing.forEach((paramBox, label) => {
            if (!declaredLabels.has(label)) {paramBox.delete()}
        })
        const seen = new Set<string>()
        declared.forEach(declaration => {
            if (seen.has(declaration.label)) {return}
            seen.add(declaration.label)
            const index = order.get(declaration.label) ?? 0
            const current = existing.get(declaration.label)
            if (isDefined(current)) {
                current.index.setValue(index)
                if (current.defaultValue.getValue() !== declaration.defaultValue) {
                    current.defaultValue.setValue(declaration.defaultValue)
                    current.value.setValue(declaration.defaultValue)
                }
            } else {
                WerkstattParameterBox.create(this.#context.boxGraph, UUID.generate(), paramBox => {
                    paramBox.owner.refer(this.#box.parameters)
                    paramBox.label.setValue(declaration.label)
                    paramBox.index.setValue(index)
                    paramBox.value.setValue(declaration.defaultValue)
                    paramBox.defaultValue.setValue(declaration.defaultValue)
                })
            }
        })
    }

    #reconcileSamples(declared: ReadonlyArray<SampleDeclaration>, order: Map<string, number>): void {
        const existing = new Map<string, WerkstattSampleBox>()
        this.#box.samples.pointerHub.incoming().forEach(({box}) => {
            const sampleBox = asInstanceOf(box, WerkstattSampleBox)
            existing.set(sampleBox.label.getValue(), sampleBox)
        })
        const declaredLabels = new Set(declared.map(({label}) => label))
        existing.forEach((sampleBox, label) => {
            if (!declaredLabels.has(label)) {sampleBox.delete()}
        })
        const seen = new Set<string>()
        declared.forEach(declaration => {
            if (seen.has(declaration.label)) {return}
            seen.add(declaration.label)
            const index = order.get(declaration.label) ?? 0
            const current = existing.get(declaration.label)
            if (isDefined(current)) {
                current.index.setValue(index)
            } else {
                WerkstattSampleBox.create(this.#context.boxGraph, UUID.generate(), sampleBox => {
                    sampleBox.owner.refer(this.#box.samples)
                    sampleBox.label.setValue(declaration.label)
                    sampleBox.index.setValue(index)
                })
            }
        })
    }
}
