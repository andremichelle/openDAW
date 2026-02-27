import css from "./CodeEditorPage.sass?inline"
import {Events, Html} from "@opendaw/lib-dom"
import {Await, createElement, PageContext, PageFactory, RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Option, panic, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {ScriptHost} from "@opendaw/studio-scripting"
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@opendaw/studio-core"
import scriptWorkerUrl from "@opendaw/studio-scripting/ScriptWorker.js?worker&url"
import ScriptSimple from "./code-editor/examples/simple.ts?raw"
import ScriptRetro from "./code-editor/examples/retro.ts?raw"
import ScriptAudioRegion from "./code-editor/examples/create-sample.ts?raw"
import ScriptNanoWavetable from "./code-editor/examples/nano-wavetable.ts?raw"
import ScriptStressTest from "./code-editor/examples/stress-test.ts?raw"
import {Promises} from "@opendaw/lib-runtime"
import {ProjectSkeleton, Sample} from "@opendaw/studio-adapters"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {Project, WavFile} from "@opendaw/studio-core"
import {AudioData} from "@opendaw/lib-dsp"

const truncateImports = (script: string) => script.substring(script.indexOf("//"))
const Examples = {
    Simple: truncateImports(ScriptSimple),
    Retro: truncateImports(ScriptRetro),
    AudioRegion: truncateImports(ScriptAudioRegion),
    NanoWavetable: truncateImports(ScriptNanoWavetable),
    StressTest: truncateImports(ScriptStressTest)
}

const className = Html.adoptStyleSheet(css, "CodeEditorPage")

export const CodeEditorPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const pendingSamples = UUID.newSet<UUID.Bytes>(uuid => uuid)
    const host = new ScriptHost({
        openProject: (buffer: ArrayBufferLike, name?: string): void => {
            const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
            boxGraph.fromArrayBuffer(buffer)
            const mandatoryBoxes = ProjectSkeleton.findMandatoryBoxes(boxGraph)
            const project = Project.fromSkeleton(service, {boxGraph, mandatoryBoxes})
            pendingSamples.forEach(uuid => project.trackUserCreatedSample(uuid))
            pendingSamples.clear()
            service.projectProfileService.setProject(project, name ?? "Scripted Project")
            service.switchScreen("default")
        },
        fetchProject: async (): Promise<{ buffer: ArrayBuffer; name: string }> => {
            return service.projectProfileService.getValue().match({
                none: () => panic("No project available"),
                some: ({project, meta}) => ({
                    buffer: ProjectSkeleton.encode(project.boxGraph) as ArrayBuffer,
                    name: meta.name
                })
            })
        },
        addSample: async (data: AudioData, name: string): Promise<Sample> => {
            const sample = await service.sampleService.importFile({
                name, arrayBuffer: WavFile.encodeFloats(data)
            })
            const uuid = UUID.parse(sample.uuid)
            service.optProject.match({
                none: () => {pendingSamples.add(uuid)},
                some: project => {project.trackUserCreatedSample(uuid)}
            })
            return sample
        }
    }, scriptWorkerUrl)
    return (
        <div className={className}>
            <Await
                factory={() => Promise.all([
                    Promises.guardedRetry(() => import("./code-editor/monaco-setup"), (_error, count) => count < 10)
                        .then(({monaco}) => monaco)
                ])}
                failure={({retry, reason}) => (<p onclick={retry}>{reason}</p>)}
                loading={() => ThreeDots()}
                success={([monaco]) => {
                    const container = (<div className="monaco-editor"/>)
                    const modelUri = monaco.Uri.parse("file:///main.ts")
                    let model = monaco.editor.getModel(modelUri)
                    if (!model) {
                        model = monaco.editor.createModel(Examples.Simple, "typescript", modelUri)
                    }
                    const editor = monaco.editor.create(container, {
                        language: "typescript",
                        quickSuggestions: {
                            other: true,
                            comments: false,
                            strings: false
                        },
                        occurrencesHighlight: "off", // prevents Firefox issue
                        suggestOnTriggerCharacters: true,
                        acceptSuggestionOnCommitCharacter: true,
                        acceptSuggestionOnEnter: "on",
                        wordBasedSuggestions: "off", // Important! Use only TS suggestions
                        model: model,
                        theme: "vs-dark",
                        automaticLayout: true
                    })
                    const allowed = ["c", "v", "x", "a", "z", "y"]
                    lifecycle.ownAll(
                        Events.subscribe(container, "keydown", event => {
                            if ((event.ctrlKey || event.metaKey) && allowed.includes(event.key.toLowerCase())) {
                                return // Let Monaco handle these
                            }
                            event.stopPropagation()
                        }),
                        Events.subscribe(container, "keyup", event => {
                            if ((event.ctrlKey || event.metaKey) && allowed.includes(event.key.toLowerCase())) {
                                return // Let Monaco handle these
                            }
                            event.stopPropagation()
                        }),
                        Events.subscribe(container, "keypress", event => event.stopPropagation())
                    )
                    requestAnimationFrame(() => editor.focus())
                    const compileAndRun = async () => {
                        try {
                            const worker = await monaco.languages.typescript.getTypeScriptWorker()
                            const client = await worker(model.uri)
                            const semanticDiagnostics = await client.getSemanticDiagnostics(model.uri.toString())
                            const syntacticDiagnostics = await client.getSyntacticDiagnostics(model.uri.toString())
                            const allDiagnostics = [...semanticDiagnostics, ...syntacticDiagnostics]
                            if (allDiagnostics.length > 0) {
                                const errors = allDiagnostics.map(d => d.messageText).join("\n")
                                await RuntimeNotifier.info({
                                    headline: "Compilation Error",
                                    message: errors
                                })
                                return
                            }
                            const emitOutput = await client.getEmitOutput(model.uri.toString())
                            if (emitOutput.outputFiles.length > 0) {
                                const jsCode = emitOutput.outputFiles[0].text
                                    .replace(/^["']use strict["'];?/, "")
                                await host.executeScript(jsCode, {
                                    sampleRate: service.audioContext.sampleRate,
                                    baseFrequency: service.optProject
                                        .map(project => project.rootBox.baseFrequency.getValue())
                                        .unwrapOrElse(440.0)
                                })
                            } else {
                                await RuntimeNotifier.info({
                                    headline: "Compiler Error",
                                    message: "No output files generated"
                                })
                            }
                        } catch (error) {
                            await RuntimeNotifier.info({
                                headline: "Compilation Error",
                                message: String(error)
                            })
                        }
                    }
                    return (
                        <div>
                            <header>
                                <Button lifecycle={lifecycle}
                                        onClick={() => RouteLocation.get().navigateTo("/")}
                                        appearance={{tooltip: "Exit editor"}}>
                                    <span>Exit</span> <Icon symbol={IconSymbol.Exit}/>
                                </Button>
                                <Button lifecycle={lifecycle}
                                        onClick={compileAndRun}
                                        appearance={{tooltip: "Run script"}}>
                                    <span>Run</span> <Icon symbol={IconSymbol.Play}/>
                                </Button>
                                <MenuButton root={MenuItem.root()
                                    .setRuntimeChildrenProcedure(parent => parent
                                        .addMenuItem(...Object.entries(Examples)
                                            .map(([name, example]) => MenuItem.default({label: name})
                                                .setTriggerProcedure(() => model.setValue(example)))))}
                                            appearance={{tinyTriangle: true, color: Colors.dark}}>
                                    <span>Examples</span>
                                </MenuButton>
                            </header>
                            {container}
                        </div>
                    )
                }}/>
        </div>
    )
}