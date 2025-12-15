import React, { useEffect, useState } from "react"
import { useApp } from "./AppContext"
const { ipcRenderer } = window.require('electron')

interface SongEntry {
    path: string;
    title: string;
    id: string;
}

export const LibrarianView = () => {
    const { settings, updateSettings, setCurrentSongPath } = useApp()
    const [songs, setSongs] = useState<SongEntry[]>([])
    const [loading, setLoading] = useState(false)
    const [filter, setFilter] = useState("")

    const handleSelectRoot = async () => {
        const path = await ipcRenderer.invoke('select-directory')
        if (path) {
            updateSettings({ projectRoot: path })
        }
    }

    const refreshSongs = async () => {
        if (!settings.projectRoot) return
        setLoading(true)
        try {
            const list: SongEntry[] = await ipcRenderer.invoke('scan-projects')
            setSongs(list)
        } catch (e) {
            console.error(e)
            alert("Failed to scan projects")
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        if (settings.projectRoot) {
            refreshSongs()
        }
    }, [settings.projectRoot])

    const filteredSongs = songs.filter(s =>
        s.title.toLowerCase().includes(filter.toLowerCase()) ||
        s.id.includes(filter)
    )

    return (
        <div style={{padding: 20, height: "100%", display: "flex", flexDirection: "column", boxSizing: "border-box"}}>
            {/* Settings / Toolbar */}
            <div style={{display: "flex", gap: 10, marginBottom: 20, alignItems: "center", background: "#2d2d30", padding: 15, borderRadius: 8}}>
                <div style={{flex: 1}}>
                    <label style={{display: "block", marginBottom: 5, fontSize: 12, color: "#aaa"}}>Project Root</label>
                    <div style={{display: "flex", gap: 5}}>
                        <input
                            type="text"
                            value={settings.projectRoot}
                            readOnly
                            style={{flex: 1, background: "#1e1e1e", border: "1px solid #3e3e42", color: "white", padding: 5}}
                        />
                        <button onClick={handleSelectRoot} style={{padding: "5px 10px"}}>Browse...</button>
                    </div>
                </div>
                <div>
                     <label style={{display: "block", marginBottom: 5, fontSize: 12, color: "#aaa"}}>ElevenLabs Key</label>
                     <input
                        type="password"
                        value={settings.elevenLabsKey}
                        onChange={e => updateSettings({elevenLabsKey: e.target.value})}
                        style={{width: 150, background: "#1e1e1e", border: "1px solid #3e3e42", color: "white", padding: 5}}
                    />
                </div>
                <button onClick={refreshSongs} style={{padding: "8px 16px", height: 36, marginTop: 18}}>Refresh Library</button>
            </div>

            {/* Song List */}
            <div style={{display: "flex", gap: 10, marginBottom: 10}}>
                <input
                    placeholder="Filter songs..."
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    style={{flex: 1, padding: 8, background: "#252526", border: "1px solid #3e3e42", color: "white"}}
                />
            </div>

            <div style={{flex: 1, overflow: "auto", border: "1px solid #3e3e42", borderRadius: 4}}>
                <table style={{width: "100%", borderCollapse: "collapse", textAlign: "left"}}>
                    <thead style={{position: "sticky", top: 0, background: "#2d2d30"}}>
                        <tr>
                            <th style={{padding: 10, borderBottom: "1px solid #3e3e42", width: 50}}>#</th>
                            <th style={{padding: 10, borderBottom: "1px solid #3e3e42"}}>Title</th>
                            <th style={{padding: 10, borderBottom: "1px solid #3e3e42"}}>ID</th>
                            <th style={{padding: 10, borderBottom: "1px solid #3e3e42", width: 100}}>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading && <tr><td colSpan={4} style={{padding: 20, textAlign: "center"}}>Loading...</td></tr>}
                        {!loading && filteredSongs.map((song, i) => (
                            <tr key={song.path} style={{borderBottom: "1px solid #2d2d30", cursor: "pointer"}}
                                onDoubleClick={() => setCurrentSongPath(song.path)}
                                className="hover-row"
                            >
                                <td style={{padding: 10}}>{i + 1}</td>
                                <td style={{padding: 10}}>{song.title}</td>
                                <td style={{padding: 10, fontFamily: "monospace", color: "#888"}}>{song.id}</td>
                                <td style={{padding: 10}}>
                                    <button onClick={() => setCurrentSongPath(song.path)}>Load</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <style>{`
                .hover-row:hover { background: #3e3e42; }
            `}</style>
        </div>
    )
}
