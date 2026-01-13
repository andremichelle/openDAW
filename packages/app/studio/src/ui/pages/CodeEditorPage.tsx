import css from "./CodeEditorPage.sass?inline"
import {Events, Html} from "@moises-ai/lib-dom"
import {Await, createElement, PageContext, PageFactory, RouteLocation} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {Colors, IconSymbol} from "@moises-ai/studio-enums"
import {Option, panic, RuntimeNotifier} from "@moises-ai/lib-std"
import {ScriptHost} from "@moises-ai/studio-scripting"
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@moises-ai/studio-core"
import scriptWorkerUrl from "@moises-ai/studio-scripting/ScriptWorker.js?worker&url"
import ScriptSimple from "./code-editor/examples/simple.ts?raw"
import ScriptRetro from "./code-editor/examples/retro.ts?raw"
import ScriptAudioRegion from "./code-editor/examples/create-sample.ts?raw"
import ScriptNanoWavetable from "./code-editor/examples/nano-wavetable.ts?raw"
import ScriptStressTest from "./code-editor/examples/stress-test.ts?raw"
import {Promises} from "@moises-ai/lib-runtime"
import {ProjectSkeleton, Sample} from "@moises-ai/studio-adapters"
import {BoxGraph} from "@moises-ai/lib-box"
import {BoxIO} from "@moises-ai/studio-boxes"
import {Project, WavFile} from "@moises-ai/studio-core"
import {AudioData} from "@moises-ai/lib-dsp"

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
    const host = new ScriptHost({
        openProject: (buffer: ArrayBufferLike, name?: string): void => {
            const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
            boxGraph.fromArrayBuffer(buffer)
            const mandatoryBoxes = ProjectSkeleton.findMandatoryBoxes(boxGraph)
            const project = Project.fromSkeleton(service, {boxGraph, mandatoryBoxes})
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
        addSample: (data: AudioData, name: string): Promise<Sample> => service.sampleService.importFile({
            name, arrayBuffer: WavFile.encodeFloats(data)
        })
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
                                    sampleRate: service.audioContext.sampleRate
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