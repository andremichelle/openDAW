import {int, Procedure} from "@moises-ai/lib-std"
import {AuxAudioUnit, GroupAudioUnit, InstrumentAudioUnit, Instruments, OutputAudioUnit, Project} from "../Api"
import {ApiImpl} from "./ApiImpl"
import {OutputAudioUnitImpl} from "./OutputAudioUnitImpl"
import {InstrumentAudioUnitImpl} from "./InstrumentAudioUnitImpl"
import {AuxAudioUnitImpl} from "./AuxAudioUnitImpl"
import {GroupAudioUnitImpl} from "./GroupAudioUnitImpl"
import {ProjectConverter} from "../ProjectConverter"

export class ProjectImpl implements Project {
    readonly #api: ApiImpl
    readonly output: OutputAudioUnit

    name: string
    bpm: number
    timeSignature: { numerator: int, denominator: int } = {numerator: 4, denominator: 4}

    #instruments: InstrumentAudioUnitImpl[] = []
    #auxUnits: AuxAudioUnitImpl[] = []
    #groupUnits: GroupAudioUnitImpl[] = []

    constructor(api: ApiImpl, name: string) {
        this.#api = api
        this.name = name
        this.bpm = 120
        this.output = new OutputAudioUnitImpl()
    }

    openInStudio(): void {
        this.#api.openProject(ProjectConverter.toSkeleton(this).boxGraph.toArrayBuffer(), this.name)
    }

    addInstrumentUnit<KEY extends keyof Instruments>(name: KEY, constructorFn?: Procedure<Instruments[KEY]>): InstrumentAudioUnit {
        const unit = new InstrumentAudioUnitImpl(name, constructorFn)
        this.#instruments.push(unit)
        return unit
    }

    addAuxUnit(props?: Partial<GroupAudioUnit>): AuxAudioUnit {
        const unit = new AuxAudioUnitImpl(props)
        this.#auxUnits.push(unit)
        return unit
    }

    addGroupUnit(props?: Partial<GroupAudioUnit>): GroupAudioUnit {
        const unit = new GroupAudioUnitImpl(props)
        this.#groupUnits.push(unit)
        return unit
    }

    get instrumentUnits(): ReadonlyArray<InstrumentAudioUnitImpl> {return this.#instruments}
    get auxUnits(): ReadonlyArray<AuxAudioUnitImpl> {return this.#auxUnits}
    get groupUnits(): ReadonlyArray<GroupAudioUnitImpl> {return this.#groupUnits}
}
