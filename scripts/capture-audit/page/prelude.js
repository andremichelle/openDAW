const sleep = millis => new Promise(resolve => setTimeout(resolve, millis))
const bootText = await (await fetch("/src/boot.ts")).text()
const bootModule = needle => [...bootText.matchAll(/["'](\/@fs[^"']+)["']/g)].map(match => match[1]).find(url => url.includes(needle))
const importsOf = async url => [...(await (await fetch(url)).text()).matchAll(/["'](\/@fs[^"']+)["']/g)].map(match => match[1])
const coreUrl = bootModule("studio/core/dist/index.js")
const P = window.__project
const core = window.__core
// Firefox has no AudioContext.setSinkId, its profile routes every context to BlackHole instead
const blackHole = async context => {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const input = devices.find(device => device.kind === "audioinput" && device.label.startsWith("BlackHole 2ch"))
    if (input === undefined) {return undefined}
    if (typeof context.setSinkId === "function") {
        const output = devices.find(device => device.kind === "audiooutput" && device.label.startsWith("BlackHole 2ch"))
        if (output === undefined) {return undefined}
        if (context.sinkId !== output.deviceId) {
            await context.setSinkId(output.deviceId)
            await sleep(500)
        }
    }
    return input
}
