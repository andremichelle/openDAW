import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle} from "@opendaw/lib-std"
import {appState} from "./AppState"
import {Html} from "@opendaw/lib-dom"

const { ipcRenderer } = window.require('electron')

interface SongEntry {
    path: string;
    title: string;
    id: string;
}

export const LibrarianView = (parentLifecycle: Lifecycle) => {
    const tableBody = <tbody/>
    const loadingRow = <tr><td colSpan={4} style={{padding: "20px", textAlign: "center"}}>Loading...</td></tr>

    let currentSongs: SongEntry[] = []
    let currentFilter = ""

    const renderTable = () => {
        Html.empty(tableBody)
        const filtered = currentSongs.filter(s =>
            s.title.toLowerCase().includes(currentFilter.toLowerCase()) ||
            s.id.includes(currentFilter)
        )

        filtered.forEach((song, i) => {
            const row = (
                <tr style={{borderBottom: "1px solid #2d2d30", cursor: "pointer"}} className="hover-row">
                    <td style={{padding: "10px"}}>{String(i + 1)}</td>
                    <td style={{padding: "10px"}}>{song.title}</td>
                    <td style={{padding: "10px", fontFamily: "monospace", color: "#888"}}>{song.id}</td>
                    <td style={{padding: "10px"}}>
                        <button onclick={(e) => {
                            e.stopPropagation()
                            appState.currentSongPath.setValue(song.path)
                        }}>Load</button>
                    </td>
                </tr>
            )
            row.onclick = () => appState.currentSongPath.setValue(song.path)
            row.onmouseenter = () => row.style.background = "#3e3e42"
            row.onmouseleave = () => row.style.background = "transparent"
            tableBody.appendChild(row)
        })
    }

    const refreshSongs = async () => {
        const root = appState.projectRoot.getValue()
        if (!root) return

        Html.empty(tableBody)
        tableBody.appendChild(loadingRow)

        try {
            currentSongs = await ipcRenderer.invoke('scan-projects')
            renderTable()
        } catch (e) {
            console.error(e)
            alert("Failed to scan projects")
            Html.empty(tableBody)
        }
    }

    const rootInput = <input
        type="text"
        readOnly
        style={{flex: "1", background: "#1e1e1e", border: "1px solid #3e3e42", color: "white", padding: "5px"}}
    />

    const sub = appState.projectRoot.subscribe(val => {
        rootInput.value = val
        refreshSongs()
    })

    parentLifecycle.own(sub)

    const keyInput = <input
        type="password"
        style={{width: "150px", background: "#1e1e1e", border: "1px solid #3e3e42", color: "white", padding: "5px"}}
    />
    parentLifecycle.own(appState.elevenLabsKey.subscribe(val => keyInput.value = val))
    keyInput.onchange = (e: any) => appState.updateSettings({elevenLabsKey: e.target.value})

    const filterInput = <input
        placeholder="Filter songs..."
        style={{flex: "1", padding: "8px", background: "#252526", border: "1px solid #3e3e42", color: "white"}}
    />
    filterInput.oninput = (e: any) => {
        currentFilter = e.target.value
        renderTable()
    }

    return (
        <div style={{padding: "20px", height: "100%", display: "flex", flexDirection: "column", boxSizing: "border-box"}}>
            {/* Settings */}
            <div style={{display: "flex", gap: "10px", marginBottom: "20px", alignItems: "center", background: "#2d2d30", padding: "15px", borderRadius: "8px"}}>
                <div style={{flex: "1"}}>
                    <label style={{display: "block", marginBottom: "5px", fontSize: "12px", color: "#aaa"}}>Project Root</label>
                    <div style={{display: "flex", gap: "5px"}}>
                        {rootInput}
                        <button style={{padding: "5px 10px"}} onclick={async () => {
                            const path = await ipcRenderer.invoke('select-directory')
                            if (path) appState.updateSettings({ projectRoot: path })
                        }}>Browse...</button>
                    </div>
                </div>
                <div>
                     <label style={{display: "block", marginBottom: "5px", fontSize: "12px", color: "#aaa"}}>ElevenLabs Key</label>
                     {keyInput}
                </div>
                <button style={{padding: "8px 16px", height: "36px", marginTop: "18px"}} onclick={refreshSongs}>Refresh Library</button>
            </div>

            {/* List */}
            <div style={{display: "flex", gap: "10px", marginBottom: "10px"}}>
                {filterInput}
            </div>

            <div style={{flex: "1", overflow: "auto", border: "1px solid #3e3e42", borderRadius: "4px"}}>
                <table style={{width: "100%", borderCollapse: "collapse", textAlign: "left"}}>
                    <thead style={{position: "sticky", top: "0", background: "#2d2d30"}}>
                        <tr>
                            <th style={{padding: "10px", borderBottom: "1px solid #3e3e42", width: "50px"}}>#</th>
                            <th style={{padding: "10px", borderBottom: "1px solid #3e3e42"}}>Title</th>
                            <th style={{padding: "10px", borderBottom: "1px solid #3e3e42"}}>ID</th>
                            <th style={{padding: "10px", borderBottom: "1px solid #3e3e42", width: "100px"}}>Action</th>
                        </tr>
                    </thead>
                    {tableBody}
                </table>
            </div>
        </div>
    )
}
