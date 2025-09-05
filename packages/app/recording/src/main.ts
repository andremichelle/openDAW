import "./style.css"
import {assert, panic, Progress, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AnimationFrame, Browser} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {AudioData, SampleMetaData, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {
    AudioWorklets,
    InstrumentFactories,
    MainThreadSampleManager,
    MidiDevices,
    Project,
    Recording,
    WorkerAgents
} from "@opendaw/studio-core"
import {testFeatures} from "./features"
import WorkersUrl from "@opendaw/studio-core/workers.js?worker&url"
import WorkletsUrl from "@opendaw/studio-core/processors.js?url"

(async () => {
    /**
     * THIS IS BOOTING CODE.
     */
    console.debug("openDAW -> recording")
    console.debug("Agent", Browser.userAgent)
    console.debug("isLocalHost", Browser.isLocalHost())
    assert(crossOriginIsolated, "window must be crossOriginIsolated")
    console.debug("booting...")
    const loadingElement = document.createElement("div")
    loadingElement.textContent = "booting..."
    document.body.append(loadingElement)
    WorkerAgents.install(WorkersUrl)
    const featureResult = await Promises.tryCatch(testFeatures())
    if (featureResult.status === "rejected") {
        alert(`Could not test features (${(featureResult.error)})`)
        return
    }
    const audioContext = new AudioContext({latencyHint: 0})
    console.debug(`AudioContext state: ${audioContext.state}, sampleRate: ${audioContext.sampleRate}`)
    const audioWorkletResult = await Promises.tryCatch(AudioWorklets.install(audioContext, WorkletsUrl))
    if (audioWorkletResult.status === "rejected") {
        alert(`Could not install Worklets (${(audioWorkletResult.error)})`)
        return
    }
    const sampleManager = new MainThreadSampleManager({
        fetch: (_uuid: UUID.Format, _progress: Progress.Handler): Promise<[AudioData, SampleMetaData]> =>
            panic("no samples for this app")
    }, audioContext)
    const env = {sampleManager, audioWorklets: audioWorkletResult.value, audioContext}

    /**
     * FROM HERE WE ACTUALLY SETUP THE STAGE.
     */
    const project = Project.new(env)
    const {api, engine, editing, boxAdapters, timelineBox} = project
    const {trackBox, audioUnitBox} = editing.modify(() => {
        timelineBox.loopArea.enabled.setValue(false)
        return api.createInstrument(InstrumentFactories.Vaporisateur)
    }).unwrap()
    project.captureDevices.get(audioUnitBox.box.address.uuid).unwrap().armed.setValue(true)
    await MidiDevices.requestPermission()
    const worklet = project.startAudioWorklet(audioWorkletResult.value)
    await worklet.isReady()
    while (!await worklet.queryLoadingComplete()) {}
    const timeInfoElement = document.createElement("div")
    timeInfoElement.textContent = "1:1"
    document.body.append(timeInfoElement)
    worklet.connect(audioContext.destination)
    const trackBoxAdapter = boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    AnimationFrame.add(() => {
        const ppqn = worklet.position.getValue()
        const {bars, beats} = PPQN.toParts(ppqn)
        timeInfoElement.textContent = `${bars + 1}:${beats + 1}`
        timeInfoElement.style.color = ppqn < 0 ? "red" : "white"

        trackBoxAdapter.regions.collection.asArray().forEach(region => {
            if(region.type !== "note-region") {return}
            if(region.optCollection.isEmpty()) {return}
            const collectionAdapter = region.optCollection.unwrap()
            collectionAdapter.events.asArray().forEach(event => {
                event.pitch
            })
        })

    })
    if (audioContext.state === "suspended") {
        window.addEventListener("click",
            async () => await audioContext.resume().then(() =>
                console.debug(`AudioContext resumed (${audioContext.state})`)), {capture: true, once: true})
    }
    AnimationFrame.start()
    loadingElement.remove()
    const recordButton = document.createElement("button")
    recordButton.textContent = "Toggle Record"
    document.body.append(recordButton)
    recordButton.onclick = () => {
        if (Recording.isRecording) {
            engine.stop(true)
            engine.play()
        } else {
            editing.modify(() => trackBox.regions.pointerHub.incoming().forEach(({box}) => box.delete()), false)
            engine.stop(true)
            project.startRecording()
        }
    }
})()