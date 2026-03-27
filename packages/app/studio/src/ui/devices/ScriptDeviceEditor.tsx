import css from "./ScriptDeviceEditor.sass?inline"
import {DeviceBoxAdapter, DeviceHost, ParameterAdapterSet, ScriptCompiler, ScriptDeclaration} from "@opendaw/studio-adapters"
import {asInstanceOf, Editing, EmptyExec, isDefined, Lifecycle, MutableObservableValue, Nullable, Observable, ObservableValue, Observer, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
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
    const controls: HTMLElement = (<div className="controls"/>)
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
    const set = UUID.newSet<{ uuid: UUID.Bytes, lifecycle: Terminable }>(({uuid}) => uuid)
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
        box.parameters.pointerHub.catchupAndSubscribe({
            onAdded: ({box: paramBox}) => {
                const werkstattParam = asInstanceOf(paramBox, WerkstattParameterBox)
                const parameter = adapter.parameters.parameterAt(werkstattParam.value.address)
                const label = werkstattParam.label.getValue()
                const declarations = ScriptDeclaration.parseParams(box.code.getValue())
                const declaration = declarations.find(decl => decl.label === label)
                const isBool = isDefined(declaration) && declaration.mapping === "bool"
                const terminator = new Terminator()
                const tracks = adapter.deviceHost().audioUnitBoxAdapter().tracks
                const element: HTMLElement = isBool
                    ? (<AutomationControl lifecycle={terminator}
                                          editing={editing}
                                          midiLearning={midiLearning}
                                          tracks={tracks}
                                          parameter={parameter}>
                        <Column ems={LKR} color={Colors.cream}>
                            <h5>{label}</h5>
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
                    : ControlBuilder.createKnob({
                        lifecycle: terminator,
                        editing,
                        midiLearning,
                        adapter,
                        parameter
                    })
                const orderTarget = element.firstElementChild as HTMLElement
                orderTarget.style.order = String(werkstattParam.index.getValue())
                terminator.own(werkstattParam.index.catchupAndSubscribe(owner =>
                    orderTarget.style.order = String(owner.getValue())))
                controls.appendChild(element)
                set.add({uuid: paramBox.address.uuid, lifecycle: terminator})
                terminator.own({terminate: () => element.remove()})
            },
            onRemoved: ({box: {address: {uuid}}}) =>
                set.removeByKey(uuid).lifecycle.terminate()
        }),
        box.samples.pointerHub.catchupAndSubscribe({
            onAdded: ({box: sampleBox}) => {
                const sample = asInstanceOf(sampleBox, WerkstattSampleBox)
                const label = sample.label.getValue()
                const terminator = new Terminator()
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
                const element: HTMLElement = (
                    <Column ems={LKR} color={Colors.cream}>
                        <h5>{label}</h5>
                        {dropZone}
                        {fileNameLabel}
                    </Column>
                )
                element.style.order = String(sample.index.getValue())
                terminator.own(sample.index.catchupAndSubscribe(owner =>
                    element.style.order = String(owner.getValue())))
                controls.appendChild(element)
                set.add({uuid: sampleBox.address.uuid, lifecycle: terminator})
                terminator.own({terminate: () => element.remove()})
            },
            onRemoved: ({box: {address: {uuid}}}) =>
                set.removeByKey(uuid).lifecycle.terminate()
        })
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => config.populateMenu(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {controls}
                              <Column ems={LKR} color={Colors.cream} style={{height: "3.5em", minWidth: "max-content"}}>
                                  <h5>Code Editor</h5>
                                  {toggleEditorButton}
                                  {errorIcon}
                              </Column>
                          </div>
                      )}
                      populateMeter={() => config.populateMeter({lifecycle, service, adapter})}
                      icon={config.icon}/>
    )
}
