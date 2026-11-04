const coreModule = await import(coreUrl)
window.__core = coreModule
const setWorklet = coreModule.EngineFacade.prototype.setWorklet
coreModule.EngineFacade.prototype.setWorklet = function (worklet) {
    window.__project = worklet.project
    window.__worklet = worklet
    return setWorklet.call(this, worklet)
}
window.__logs = []
for (const level of ["debug", "warn", "error"]) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
        window.__logs.push(level + " " + args.map(arg => typeof arg === "object" ? JSON.stringify(arg) : String(arg)).join(" "))
        original(...args)
    }
}
const effects = (await importsOf(coreUrl)).find(url => url.includes("core/dist/EffectFactories.js"))
window.__adapters = await import((await importsOf(effects)).find(url => url.includes("adapters/dist/index.js")))
window.__std = await import(bootModule("lib/std/dist/index.js"))
const findNewProject = () => [...document.querySelectorAll("button, div, span")]
    .find(element => element.textContent.trim() === "New Project")
for (let attempt = 0; attempt < 300 && findNewProject() === undefined; attempt++) {await sleep(100)}
if (findNewProject() === undefined) {return {error: "no 'New Project' button", text: document.body.innerText.slice(0, 300)}}
findNewProject().click()
await sleep(4000)
document.querySelectorAll("button").forEach(button => {if (button.textContent.trim() === "Not now") {button.click()}})
// every permission request opens and closes a stream, which moves an armed capture's input: ask once, up front
await window.__core.AudioDevices.requestPermission()
const project = window.__project
const {InstrumentFactories} = window.__adapters
project.editing.modify(() => {
    project.api.createAnyInstrument(InstrumentFactories.Vaporisateur)
    project.api.createAnyInstrument(InstrumentFactories.Tape)
})
await sleep(500)
return project.captureDevices.allCaptures().map(capture => capture.constructor.name)
