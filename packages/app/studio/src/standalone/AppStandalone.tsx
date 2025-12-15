import React, {useState} from "react"
import {LibrarianView} from "./LibrarianView"
import {WorkbenchView} from "./WorkbenchView"
import {AppProvider, useApp} from "./AppContext"

const AppContent = () => {
    const [view, setView] = useState<"librarian" | "workbench">("librarian")
    const { currentSongPath } = useApp()

    const handleNavigate = (v: "librarian" | "workbench") => {
        setView(v)
    }

    // Auto-switch to workbench when a song is loaded
    React.useEffect(() => {
        if (currentSongPath) {
            setView("workbench")
        }
    }, [currentSongPath])

    return (
        <div style={{display: "flex", flexDirection: "column", height: "100vh", background: "#1e1e1e", color: "white", fontFamily: "sans-serif"}}>
            <div style={{height: 48, borderBottom: "1px solid #333", display: "flex", alignItems: "center", padding: "0 16px", background: "#252526"}}>
                <div style={{fontWeight: "bold", marginRight: 20}}>StageTraxx Tools</div>
                <button
                    onClick={() => handleNavigate("librarian")}
                    style={{
                        background: view === "librarian" ? "#3e3e42" : "transparent",
                        border: "none",
                        color: "white",
                        padding: "8px 16px",
                        cursor: "pointer",
                        borderRadius: 4
                    }}
                >
                    Librarian
                </button>
                <button
                    onClick={() => handleNavigate("workbench")}
                    disabled={!currentSongPath}
                    style={{
                        background: view === "workbench" ? "#3e3e42" : "transparent",
                        border: "none",
                        color: currentSongPath ? "white" : "#666",
                        padding: "8px 16px",
                        cursor: "pointer",
                        borderRadius: 4,
                        marginLeft: 8
                    }}
                >
                    Workbench
                </button>
            </div>
            <div style={{flex: 1, overflow: "hidden", position: "relative"}}>
                {view === "librarian" ? <LibrarianView /> : <WorkbenchView />}
            </div>
        </div>
    )
}

export const AppStandalone = () => {
    return (
        <AppProvider>
            <AppContent/>
        </AppProvider>
    )
}
