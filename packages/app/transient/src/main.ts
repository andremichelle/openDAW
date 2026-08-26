import {assert, isDefined, Nullable} from "@opendaw/lib-std"
import {TransientDetector} from "./detector"
import {createTransientView, TransientView} from "./view"
import {loadSample, SAMPLE_FILES} from "./samples"

(async () => {
    assert(crossOriginIsolated, "window must be crossOriginIsolated")

    const context = new AudioContext()

    const title = document.createElement("h1")
    title.textContent = "Transient Lab"

    const select = document.createElement("select")
    SAMPLE_FILES.forEach(name => {
        const option = document.createElement("option")
        option.value = name
        option.textContent = name.replace(/\.wav$/i, "")
        select.append(option)
    })

    const legend = document.createElement("div")
    legend.className = "legend"
    legend.innerHTML =
        "<span class='detected'>▮ detected (weight = strength)</span>" +
        "<span class='comparison'>▮ comparison (.json)</span>"

    const spacer = document.createElement("div")
    spacer.className = "spacer"

    const header = document.createElement("header")
    header.append(title, select, spacer, legend)

    const container = document.createElement("div")
    container.className = "view"
    container.style.flex = "1"
    container.style.minHeight = "0"

    document.body.append(header, container)

    const detector = await TransientDetector.load("/stretch_wasm.wasm")

    let current: Nullable<TransientView> = null
    const openFile = async (name: string): Promise<void> => {
        select.disabled = true
        const sample = await loadSample(name)
        const detected = detector.detect(sample.audio)
        if (isDefined(current)) {current.dispose()}
        const view = createTransientView({sample, detected, context})
        current = view
        container.replaceChildren(view.element)
        select.disabled = false
    }

    select.onchange = () => void openFile(select.value)
    await openFile(SAMPLE_FILES[0])
})()
