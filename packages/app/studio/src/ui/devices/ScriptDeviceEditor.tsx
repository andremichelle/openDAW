import css from "./ScriptDeviceEditor.sass?inline"
import {DeclarationSection, DeviceBoxAdapter, DeviceHost, ParamDeclaration, ParameterAdapterSet, SampleDeclaration, ScriptCompiler, ScriptDeclaration} from "@opendaw/studio-adapters"
import {asInstanceOf, Color, Editing, EmptyExec, isDefined, Lifecycle, MutableObservableValue, Nullable, Observable, ObservableValue, Observer, Subscription, Terminator, UUID} from "@opendaw/lib-std"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {Promises} from "@opendaw/lib-runtime"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {Clipboard, Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {AudioFileBox, WerkstattParameterBox, WerkstattSampleBox} from "@opendaw/studio-boxes"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {Icon} from "@/ui/components/Icon"
import {Column} from "@/ui/devices/Column"
import {LKR} from "@/ui/devices/constants"
import {CodeEditorExample} from "@/ui/code-editor/CodeEditorState"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {MenuItem} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "ScriptDeviceEditor")

const boolModel = (editing: Editing, parameter: AutomatableParameterFieldAdapter<number>): MutableObservableValue<boolean> =>
    new class implements MutableObservableValue<boolean> {
        getValue(): boolean {return parameter.getControlledValue() >= 0.5}
        setValue(value: boolean) {editing.modify(() => parameter.setValue(value ? 1 : 0))}
        subscribe(observer: Observer<ObservableValue<boolean>>): Subscription {
            return parameter.subscribe(() => observer(this))
        }
        catchupAndSubscribe(observer: Observer<ObservableValue<boolean>>): Subscription {
            return parameter.catchupAndSubscribe(() => observer(this))
        }
    }

type ScriptAdapter = DeviceBoxAdapter & {
    readonly box: ScriptCompiler.ScriptDeviceBox
    readonly parameters: ParameterAdapterSet
    readonly codeChanged: Observable<void>
}

export type ScriptDeviceEditorConfig = {
    readonly compiler: ScriptCompiler.Config
    readonly defaultCode: string
    readonly examples: ReadonlyArray<CodeEditorExample>
    readonly starterPrompt: string
    readonly icon: IconSymbol
    readonly populateMenu: (parent: MenuItem, service: StudioService, deviceHost: DeviceHost, adapter: ScriptAdapter) => void
    readonly populateMeter: (construct: {
        lifecycle: Lifecycle,
        service: StudioService,
        adapter: ScriptAdapter
    }) => Nullable<HTMLElement>
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ScriptAdapter
    deviceHost: DeviceHost
    config: ScriptDeviceEditorConfig
}

export const ScriptDeviceEditor = ({lifecycle, service, adapter, deviceHost, config}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const compiler = ScriptCompiler.create(config.compiler)
    const box = adapter.box
    const storedCode = box.code.getValue()
    const userCode = storedCode.length > 0 ? compiler.stripHeader(storedCode) : config.defaultCode
    let compiling = false
    const compile = async (code: string) => {
        compiling = true
        try {
            const result = await Promises.tryCatch(compiler.compile(service.audioContext, editing, box, code))
            if (result.status === "resolved") {
                errorIcon.classList.add("hidden")
                errorIcon.title = ""
            } else {
                errorIcon.classList.remove("hidden")
                errorIcon.title = String(result.error)
                throw result.error
            }
        } finally {
            compiling = false
        }
    }
    if (storedCode.length > 0) {
        compiler.load(service.audioContext, box).finally(EmptyExec)
    } else {
        compiler.compile(service.audioContext, editing, box, userCode, true).finally(EmptyExec)
    }
    const toggleEditor = () => {
        const isActive = service.activeCodeEditor
            .map(state => UUID.equals(state.handler.uuid, adapter.uuid)).unwrapOrElse(false)
        if (isActive) {
            service.closeCodeEditor()
        } else {
            service.openCodeEditor({
                handler: {
                    uuid: adapter.uuid,
                    name: adapter.labelField,
                    compile,
                    subscribeErrors: observer =>
                        service.engine.subscribeDeviceMessage(UUID.toString(adapter.uuid), observer),
                    subscribeCode: observer =>
                        box.code.subscribe(owner => observer(compiler.stripHeader(owner.getValue())))
                },
                initialCode: compiler.stripHeader(box.code.getValue()) || config.defaultCode,
                previousScreen: service.layout.screen.getValue(),
                examples: config.examples,
                starterPrompt: config.starterPrompt
            })
        }
    }
    const resolveGroupColor = (colorName: string): Color => {
        const color = (Colors as Record<string, Color>)[colorName]
        return isDefined(color) ? color : Colors.dark
    }
    const toggleEditorButton: HTMLElement = (
        <Button lifecycle={lifecycle}
                onClick={toggleEditor}
                appearance={{framed: true, tooltip: "Toggle Code Editor"}}
                style={{fontSize: "16px", marginTop: "4px"}}>
            <Icon symbol={IconSymbol.Code}/>
        </Button>
    )
    let lastErrorMessage = ""
    const errorIcon: HTMLElement = (
        <div className="error hidden"
             style={{cursor: "pointer"}}
             onclick={() => Clipboard.writeText(lastErrorMessage)}>
            <Icon symbol={IconSymbol.Bug}/>
        </div>
    )
    const controlsContainer: HTMLElement = (<div className={className}/>)
    const controlsTerminator = lifecycle.own(new Terminator())
    const paramBoxesByLabel = new Map<string, WerkstattParameterBox>()
    const sampleBoxesByLabel = new Map<string, WerkstattSampleBox>()
    const createParamElement = (terminator: Terminator, declaration: ParamDeclaration): HTMLElement => {
        const werkstattParam = paramBoxesByLabel.get(declaration.label)
        if (!isDefined(werkstattParam)) {return <div/>}
        const parameter = adapter.parameters.parameters()
            .find(param => param.address.equals(werkstattParam.value.address))
        if (!isDefined(parameter)) {return <div/>}
        const tracks = adapter.deviceHost().audioUnitBoxAdapter().tracks
        return declaration.mapping === "bool"
            ? (<AutomationControl lifecycle={terminator}
                                  editing={editing}
                                  midiLearning={midiLearning}
                                  tracks={tracks}
                                  parameter={parameter}>
                <Column ems={LKR} color={Colors.cream}>
                    <h5>{declaration.label}</h5>
                    <Checkbox lifecycle={terminator}
                              model={boolModel(editing, parameter)}
                              style={{marginTop: "0.25em"}}
                              appearance={{
                                  color: Colors.cream,
                                  activeColor: Colors.blue,
                                  framed: true,
                                  cursor: "pointer"
                              }}>
                        <Icon symbol={IconSymbol.Checkbox}/>
                    </Checkbox>
                </Column>
            </AutomationControl>)
            : ControlBuilder.createKnob({lifecycle: terminator, editing, midiLearning, adapter, parameter})
    }
    const createSampleElement = (terminator: Terminator, declaration: SampleDeclaration): HTMLElement => {
        const sample = sampleBoxesByLabel.get(declaration.label)
        if (!isDefined(sample)) {return <div/>}
        const fileNameLabel: HTMLSpanElement = (<span className="sample-name"/>)
        const dropZone: HTMLElement = (
            <div className="sample-drop">
                <Icon symbol={IconSymbol.Waveform}/>
            </div>
        )
        const sampleSelector = new SampleSelector(service, {
            hasSample: () => sample.file.nonEmpty(),
            replace: (replacement) => replacement.match({
                none: () => sample.file.targetVertex.ifSome(({box: fileBox}) => {
                    const mustDelete = fileBox.pointerHub.size() === 1
                    sample.file.defer()
                    if (mustDelete) {fileBox.delete()}
                }),
                some: () => SampleSelectStrategy.changePointer(sample.file, replacement)
            })
        })
        terminator.ownAll(
            sample.file.catchupAndSubscribe(pointer => pointer.targetVertex.match({
                none: () => {
                    dropZone.removeAttribute("sample")
                    fileNameLabel.textContent = ""
                },
                some: ({box: fileBox}) => {
                    const name = asInstanceOf(fileBox, AudioFileBox).fileName.getValue()
                    dropZone.setAttribute("sample", name)
                    fileNameLabel.textContent = name
                }
            })),
            sampleSelector.configureBrowseClick(dropZone),
            sampleSelector.configureContextMenu(dropZone),
            sampleSelector.configureDrop(dropZone)
        )
        return (
            <Column ems={LKR} color={Colors.cream}>
                <h5>{declaration.label}</h5>
                {dropZone}
                {fileNameLabel}
            </Column>
        )
    }
    const populateSection = (terminator: Terminator, section: DeclarationSection, container: HTMLElement): void => {
        const controls: HTMLElement = (<div className="controls"/>)
        for (const item of section.items) {
            controls.appendChild(item.type === "param"
                ? createParamElement(terminator, item.declaration)
                : createSampleElement(terminator, item.declaration))
        }
        if (isDefined(section.group)) {
            const color = resolveGroupColor(section.group.color)
            controls.style.backgroundColor = color.opacity(0.03).toString()
            const group: HTMLElement = (
                <div className="group">
                    <div className="group-header" style={{backgroundColor: color.opacity(0.33).toString()}}>
                        <span>{section.group.label}</span>
                    </div>
                    {controls}
                </div>
            )
            container.appendChild(group)
        } else {
            container.appendChild(controls)
        }
    }
    const rebuildControls = () => {
        controlsTerminator.terminate()
        controlsContainer.replaceChildren()
        const sections = ScriptDeclaration.parseGroups(box.code.getValue())
        const terminator = new Terminator()
        if (sections.length === 0) {
            controlsContainer.appendChild(<div className="controls"/>)
        }
        for (const section of sections) {populateSection(terminator, section, controlsContainer)}
        const codeEditorColumn: HTMLElement = (
            <Column ems={LKR} color={Colors.cream} style={{height: "3.5em", minWidth: "max-content"}}>
                <h5>Code Editor</h5>
                {toggleEditorButton}
                {errorIcon}
            </Column>
        )
        controlsContainer.appendChild(codeEditorColumn)
        controlsTerminator.own(terminator)
    }
    const indexParamBoxes = () => {
        paramBoxesByLabel.clear()
        for (const pointer of box.parameters.pointerHub.incoming()) {
            const werkstattParam = asInstanceOf(pointer.box, WerkstattParameterBox)
            paramBoxesByLabel.set(werkstattParam.label.getValue(), werkstattParam)
        }
    }
    const indexSampleBoxes = () => {
        sampleBoxesByLabel.clear()
        for (const pointer of box.samples.pointerHub.incoming()) {
            const sample = asInstanceOf(pointer.box, WerkstattSampleBox)
            sampleBoxesByLabel.set(sample.label.getValue(), sample)
        }
    }
    const scheduleRebuild = () => {
        indexParamBoxes()
        indexSampleBoxes()
        rebuildControls()
    }
    lifecycle.ownAll(
        service.engine.subscribeDeviceMessage(UUID.toString(adapter.uuid), message => {
            lastErrorMessage = message
            errorIcon.classList.remove("hidden")
            errorIcon.title = message
        }),
        {
            terminate: () => {
                const isActive = service.activeCodeEditor
                    .map(state => UUID.equals(state.handler.uuid, adapter.uuid)).unwrapOrElse(false)
                if (isActive) {service.closeCodeEditor()}
            }
        },
        adapter.codeChanged.subscribe(() => {
            if (!compiling) {compiler.load(service.audioContext, box).finally(EmptyExec)}
        }),
        service.activeCodeEditor.catchupAndSubscribe(option => {
            const isActive = option.map(state => UUID.equals(state.handler.uuid, adapter.uuid)).unwrapOrElse(false)
            toggleEditorButton.classList.toggle("active", isActive)
        }),
        box.parameters.pointerHub.subscribe({onAdded: scheduleRebuild, onRemoved: scheduleRebuild}),
        box.samples.pointerHub.subscribe({onAdded: scheduleRebuild, onRemoved: scheduleRebuild}),
        box.code.subscribe(scheduleRebuild)
    )
    scheduleRebuild()
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => config.populateMenu(parent, service, deviceHost, adapter)}
                      populateControls={() => controlsContainer}
                      populateMeter={() => config.populateMeter({lifecycle, service, adapter})}
                      icon={config.icon}/>
    )
}
