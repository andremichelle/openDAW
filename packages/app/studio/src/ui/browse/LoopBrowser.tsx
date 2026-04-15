import css from "./LoopBrowser.sass?inline"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "LoopBrowser")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

type LoopData = {
    id: string
    name: string
    category: string
    bpm: number
    key: string | null
    bars: number
    duration: number
    file: string
}

export const LoopBrowser = ({lifecycle, service}: Construct) => {
    const query = new DefaultObservableValue("")
    const activeCategory = new DefaultObservableValue("All")
    const playingId = new DefaultObservableValue<string | null>(null)
    const elementsContainer = <div className="loops-list"></div>
    
    const categories = ["All", "Drums", "Bass", "Melodic", "Vocals", "FX"]
    let loops: Array<LoopData> = []
    
    const playLoop = (id: string) => {
        if (playingId.getValue() === id) {
            playingId.setValue(null)
        } else {
            playingId.setValue(id)
        }
        renderLoops()
    }
    
    const renderLoops = () => {
        const q = query.getValue().toLowerCase()
        const cat = activeCategory.getValue()
        
        const filtered = loops.filter(l => 
            (cat === "All" || l.category === cat) &&
            (l.name.toLowerCase().includes(q))
        )
        
        elementsContainer.innerHTML = "" // clear elements
        
        filtered.forEach(loop => {
            const isPlaying = playingId.getValue() === loop.id
            const card = (
                <div className={`loop-card ${isPlaying ? 'playing' : ''}`} draggable="true">
                    <div className="play-btn" onInit={el => el.onclick = () => playLoop(loop.id)}>
                        <Icon symbol={IconSymbol.Play} />
                    </div>
                    <div className="loop-info">
                        <span className="loop-name">{loop.name}</span>
                        <span className="loop-meta">
                            <span>{loop.bpm} BPM</span>
                            {loop.key ? <span>Key: {loop.key}</span> : null}
                        </span>
                    </div>
                    <div className="loop-waveform">
                        <div style={{height: "40%"}}></div>
                        <div style={{height: "70%"}}></div>
                        <div style={{height: "30%"}}></div>
                        <div style={{height: "90%"}}></div>
                        <div style={{height: "50%"}}></div>
                    </div>
                </div>
            )
            elementsContainer.appendChild(card)
        })
    }
    
    fetch("/assets/loops/index.json")
        .then(res => res.json())
        .then(data => {
            loops = data.loops || []
            renderLoops()
        })
        .catch(err => console.warn("Could not load loops index", err))

    return (
        <div className={className}>
            <div className="header">
                <input 
                    type="text" 
                    className="search-input" 
                    placeholder="Search loops..." 
                    onInit={el => {
                        el.oninput = () => {
                            query.setValue(el.value)
                            renderLoops()
                        }
                    }}
                />
                <div className="categories">
                    {categories.map(cat => (
                        <div 
                            className="category-btn"
                            onInit={el => {
                                lifecycle.own(activeCategory.catchupAndSubscribe(owner => {
                                    if (owner.getValue() === cat) el.classList.add("active")
                                    else el.classList.remove("active")
                                }))
                                el.onclick = () => {
                                    activeCategory.setValue(cat)
                                    renderLoops()
                                }
                            }}
                        >
                            {cat}
                        </div>
                    ))}
                </div>
            </div>
            {elementsContainer}
        </div>
    )
}
