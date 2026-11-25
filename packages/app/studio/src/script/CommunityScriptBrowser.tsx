import css from "./CommunityScriptBrowser.sass?inline"
import {
    DefaultObservableValue,
    isDefined,
    Lifecycle,
    MutableObservableOption,
    MutableObservableValue,
    Observable,
    Option,
    Procedure,
    RuntimeNotifier
} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Await, createElement} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {Button} from "@/ui/components/Button"
import {SearchInput} from "@/ui/components/SearchInput"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {CommunityAPI} from "@/opendaw-api/CommunityAPI"
import {CommunityScript, CommunityScriptTarget} from "@/opendaw-api/CommunityIndex"
import {ScriptLink, ScriptLinkFile} from "@/opendaw-api/ScriptLink"

const className = Html.adoptStyleSheet(css, "CommunityScriptBrowser")

const ContributeUrl = "/manuals/community-scripts"

export type CommunityScriptPick = { readonly name: string, readonly source: string }

type Entry =
    | { readonly kind: "community", readonly key: string, readonly name: string, readonly script: CommunityScript }
    | { readonly kind: "link", readonly key: string, readonly name: string, readonly file: ScriptLinkFile }

type Construct = {
    lifecycle: Lifecycle
    target: CommunityScriptTarget
    open: Procedure<CommunityScriptPick>
    nothingSelected: MutableObservableValue<boolean>
    openRequests: Observable<void>
}

const matches = (script: CommunityScript, filter: string): boolean => {
    if (filter.length === 0) {return true}
    const words = filter.toLowerCase().split(/\s+/).filter(word => word.length > 0)
    const text = [script.name, script.description, script.author.name, ...script.tags].join(" ").toLowerCase()
    return words.every(word => text.includes(word))
}

export const CommunityScriptBrowser = ({lifecycle, target, open, nothingSelected, openRequests}: Construct) => {
    const api = CommunityAPI.get()
    const filter = lifecycle.own(new DefaultObservableValue(""))
    const selection = lifecycle.own(new MutableObservableOption<Entry>())
    const sources = new Map<string, Promise<string>>()
    const linkEntries: Array<Entry> = []
    const sourceOf = (entry: Entry): Promise<string> => {
        const cached = sources.get(entry.key)
        if (isDefined(cached)) {return cached}
        const loading = entry.kind === "community"
            ? api.loadSource(entry.script)
            : ScriptLink.load(entry.file).then(({source}) => source)
        loading.catch(() => sources.delete(entry.key))
        sources.set(entry.key, loading)
        return loading
    }
    const openEntry = async (entry: Entry): Promise<void> => {
        const {status, value, error} = await Promises.tryCatch(sourceOf(entry))
        if (status === "rejected") {
            RuntimeNotifier.notify({message: `Could not load '${entry.name}': ${String(error)}`, icon: "Warning"})
            return
        }
        open({name: entry.name, source: value})
    }
    const list: HTMLElement = <div className="list" onConnect={element => lifecycle.own(installScrollbars(element))}/>
    const description: HTMLElement = <div className="description">Select a script on the left, or paste a GitHub link below.</div>
    const tags: HTMLElement = <div className="tags hidden"/>
    const code: HTMLElement = <pre className="code hidden"/>
    const github: HTMLAnchorElement = (
        <a className="github hidden" target="_blank" rel="noopener">View on GitHub</a>
    )
    const preview: HTMLImageElement = (
        <img className="preview hidden" alt=""
             onload={() => preview.style.width = `${preview.naturalWidth / 2}px`}/>
    )
    const detail: HTMLElement = (
        <div className="detail empty" onConnect={element => lifecycle.own(installScrollbars(element))}>
            {preview}
            {tags}
            {description}
            {code}
            {github}
        </div>
    )
    const linkField: HTMLInputElement = (
        <input className="default" type="text" placeholder="Paste a GitHub link to a script, folder or pull request"/>
    )
    const showDetail = (entry: Entry): void => {
        detail.classList.remove("empty")
        github.classList.remove("hidden")
        const screenshot = entry.kind === "community" ? CommunityAPI.get().screenshotOf(entry.script) : Option.None
        preview.classList.toggle("hidden", screenshot.isEmpty())
        screenshot.match({
            none: () => preview.removeAttribute("src"),
            some: url => {
                preview.style.removeProperty("width")
                preview.src = url
            }
        })
        if (entry.kind === "community") {
            const {script} = entry
            description.textContent = script.description
            tags.replaceChildren(...script.tags.map(tag => <button className="tag" onclick={() => filter.setValue(tag)}>{tag}</button>))
            tags.classList.toggle("hidden", script.tags.length === 0)
            code.classList.add("hidden")
            github.href = script.source
        } else {
            const {owner, repo, ref, path} = entry.file
            description.textContent = "Loaded from a link, nothing is saved until you save it in the editor."
            tags.replaceChildren()
            tags.classList.add("hidden")
            code.classList.remove("hidden")
            code.textContent = "Loading..."
            github.href = `https://github.com/${owner}/${repo}/blob/${ref}/${path}`
            sourceOf(entry).then(
                source => {if (selection.contains(entry)) {code.textContent = source}},
                error => {if (selection.contains(entry)) {code.textContent = String(error)}})
        }
    }
    const renderList = (scripts: ReadonlyArray<CommunityScript>): void => {
        const community: ReadonlyArray<Entry> = scripts
            .filter(script => matches(script, filter.getValue()))
            .map(script => ({kind: "community", key: script.uuid, name: script.name, script}))
        list.replaceChildren(...[...linkEntries, ...community].map(entry => {
            const row: HTMLElement = (
                <div className={Html.buildClassList("entry", entry.kind)}
                     onclick={() => selection.wrap(entry)}
                     ondblclick={() => openEntry(entry)}>
                    <span className="name">{entry.name}</span>
                    {entry.kind === "community" && isDefined(entry.script.author.github)
                        ? <a className="author" href={`https://github.com/${entry.script.author.github}`}
                             target="_blank" rel="noopener">{entry.script.author.name}</a>
                        : <span className="author">{entry.kind === "community" ? entry.script.author.name : "link"}</span>}
                </div>
            )
            row.classList.toggle("selected", selection.mapOr(selected => selected.key === entry.key, false))
            return row
        }))
    }
    const loadLink = async (scripts: ReadonlyArray<CommunityScript>): Promise<void> => {
        const location = ScriptLink.parse(linkField.value)
        if (location.isEmpty()) {
            RuntimeNotifier.notify({message: "That is not a GitHub link to a script.", icon: "Info"})
            return
        }
        const {status, value: files, error} = await Promises.tryCatch(ScriptLink.candidates(location.unwrap()))
        if (status === "rejected") {
            RuntimeNotifier.notify({message: String(error), icon: "Warning"})
            return
        }
        const fitting = files.filter(file => {
            const match = /(^|\/)scripts\/([a-z]+)\//.exec(file.path)
            return !isDefined(match) || match[2] === target
        })
        if (fitting.length === 0) {
            RuntimeNotifier.notify({message: `The link holds no ${target} script.`, icon: "Info"})
            return
        }
        const loaded = await Promises.tryCatch(Promise.all(fitting.map(file => ScriptLink.load(file))))
        if (loaded.status === "rejected") {
            RuntimeNotifier.notify({message: String(loaded.error), icon: "Warning"})
            return
        }
        const added: ReadonlyArray<Entry> = fitting.map((file, index) => {
            const key = `${file.owner}/${file.repo}/${file.ref}/${file.path}`
            sources.set(key, Promise.resolve(loaded.value[index].source))
            return {kind: "link", key, name: loaded.value[index].name, file}
        })
        linkEntries.splice(0, linkEntries.length, ...added)
        linkField.value = ""
        selection.wrap(added[0])
        renderList(scripts)
    }
    return (
        <div className={className}>
            <Await factory={() => api.scriptsFor(target)}
                   loading={() => (<div className="loader"><ThreeDots/></div>)}
                   failure={({reason, retry}) => (<div className="error" onclick={retry}>{String(reason)}</div>)}
                   success={scripts => {
                       lifecycle.ownAll(
                           filter.subscribe(() => renderList(scripts)),
                           selection.subscribe(option => {
                               option.ifSome(showDetail)
                               nothingSelected.setValue(option.isEmpty())
                               renderList(scripts)
                           }),
                           openRequests.subscribe(() => selection.ifSome(entry => openEntry(entry))))
                       renderList(scripts)
                       linkField.onkeydown = event => {
                           if (event.code !== "Enter") {return}
                           event.preventDefault()
                           event.stopPropagation()
                           loadLink(scripts).finally()
                       }
                       return (
                           <div className="content">
                               <SearchInput lifecycle={lifecycle} model={filter} placeholder="Search"/>
                               <div className="list-frame">
                                   <header>
                                       <span>Name</span>
                                       <span>Author</span>
                                   </header>
                                   {list}
                               </div>
                               {detail}
                               <div className="link">
                                   {linkField}
                                   <Button lifecycle={lifecycle}
                                           onClick={() => loadLink(scripts).finally()}
                                           appearance={{color: Colors.shadow, cursor: "pointer", tooltip: "Load the script from GitHub without saving it"}}>
                                       Load
                                   </Button>
                                   <a href={ContributeUrl} target="manuals">How to contribute?</a>
                               </div>
                           </div>
                       )
                   }}/>
        </div>
    )
}
