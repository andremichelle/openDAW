import {createElement} from "@opendaw/lib-jsx"
import {Terminator, DefaultObservableValue} from "@opendaw/lib-std"
import {LibrarianView} from "./LibrarianView"
import {WorkbenchView} from "./WorkbenchView"
import {appState} from "./AppState"
import {Html} from "@opendaw/lib-dom"

export const AppStandalone = () => {
    const lifecycle = new Terminator()
    const view = new DefaultObservableValue<"librarian" | "workbench">("librarian")

    // Auto-switch to workbench when song loaded
    lifecycle.own(appState.currentSongPath.subscribe(owner => {
        const path = owner.getValue()
        if (path) view.setValue("workbench")
    }))

    const contentContainer = <div style={{flex: "1", overflow: "hidden", position: "relative"}}/>

    const renderContent = () => {
        const v = view.getValue()
        Html.empty(contentContainer)
        if (v === "librarian") {
            contentContainer.appendChild(LibrarianView(lifecycle))
        } else {
            contentContainer.appendChild(WorkbenchView(lifecycle))
        }
    }

    lifecycle.own(view.subscribe(renderContent))
    renderContent()

    const btnStyle = (active: boolean) => ({
        background: active ? "#3e3e42" : "transparent",
        border: "none",
        color: "white",
        padding: "8px 16px",
        cursor: "pointer",
        borderRadius: "4px",
        marginLeft: "8px"
    })

    const navBtnLibrarian = <button style={btnStyle(true)}>Librarian</button>
    navBtnLibrarian.onclick = () => view.setValue("librarian")

    const navBtnWorkbench = <button style={btnStyle(false)}>Workbench</button>
    navBtnWorkbench.onclick = () => view.setValue("workbench")

    lifecycle.own(view.subscribe(owner => {
        const v = owner.getValue()
        Object.assign(navBtnLibrarian.style, btnStyle(v === "librarian"))
        Object.assign(navBtnWorkbench.style, btnStyle(v === "workbench"))
        const path = appState.currentSongPath.getValue()
        navBtnWorkbench.disabled = !path
        navBtnWorkbench.style.color = navBtnWorkbench.disabled ? "#666" : "white"
    }))

    lifecycle.own(appState.currentSongPath.subscribe(owner => {
         const p = owner.getValue()
         navBtnWorkbench.disabled = !p
         navBtnWorkbench.style.color = navBtnWorkbench.disabled ? "#666" : "white"
    }))

    return (
        <div style={{display: "flex", flexDirection: "column", height: "100vh", background: "#1e1e1e", color: "white", fontFamily: "sans-serif"}}>
            <div style={{height: "48px", borderBottom: "1px solid #333", display: "flex", alignItems: "center", padding: "0 16px", background: "#252526"}}>
                <div style={{fontWeight: "bold", marginRight: "20px"}}>StageTraxx Tools</div>
                {navBtnLibrarian}
                {navBtnWorkbench}
            </div>
            {contentContainer}
        </div>
    )
}
