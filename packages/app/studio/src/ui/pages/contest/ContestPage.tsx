import css from "./ContestPage.sass?inline"
import {createElement, PageContext, PageFactory, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, int, isDefined, Lifecycle, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {BackButton} from "@/ui/pages/BackButton"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {Contest} from "./Contest"
import {ContestArt} from "./ContestArt"

const className = Html.adoptStyleSheet(css, "ContestPage")

type Phase =
    | { type: "idle" }
    | { type: "busy", step: Contest.Step, progress: number }
    | { type: "done", id: string, projectName: string }
    | { type: "failed", message: string }

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    contest: Contest.Definition
}

const twoDigits = (value: int): string => String(value).padStart(2, "0")

const clock = (seconds: number): string => {
    const whole = Math.ceil(seconds)
    return `${Math.floor(whole / 60)}:${twoDigits(whole % 60)}`
}

const EmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const ContestContent = ({lifecycle, service, contest}: Construct) => {
    const serverOffset = contest.serverTime - Date.now()
    const deadline = Date.parse(contest.deadline)
    const cells: ReadonlyArray<HTMLElement> = ["Days", "Hours", "Minutes", "Seconds"].map(() => <span/>)
    const nameInput: HTMLInputElement = (
        <input type="text" className="default" maxLength={80} placeholder="Your name or artist name"/>
    )
    const emailInput: HTMLInputElement = (
        <input type="email" className="default" maxLength={254} placeholder="you@example.com"/>
    )
    const consentModels = contest.consents.map(() => new DefaultObservableValue(false))
    const buttonLabel: HTMLElement = <span/>
    const button: HTMLButtonElement = (
        <button type="button" className="submit">
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>
            </svg>
            {buttonLabel}
        </button>
    )
    const hint: HTMLElement = <div className="hint"/>
    const termsScroller: HTMLElement = (
        <div className="scroller">
            {contest.terms.sections.map(({heading, text}) => (
                <div><h4>{heading}</h4><p>{text}</p></div>
            ))}
        </div>
    )
    let phase: Phase = {type: "idle"}
    let blockedUntil = 0
    const formValid = (): boolean => nameInput.value.trim().length > 0
        && EmailPattern.test(emailInput.value.trim())
        && consentModels.every(model => model.getValue())
    const fields: HTMLElement = (
        <div className="fields">
            <label>Name (shown in the credits){nameInput}</label>
            <label>Email (only for contacting you){emailInput}</label>
        </div>
    )
    const consents: HTMLElement = (
        <div className="consents">
            {contest.consents.map(({label}, index) => (
                <div className="consent">
                    <Checkbox lifecycle={lifecycle} model={consentModels[index]}
                              appearance={{framed: true, color: Colors.black}}>
                        <Icon symbol={IconSymbol.Checkbox}/>
                    </Checkbox>
                    <span onclick={() => consentModels[index].setValue(!consentModels[index].getValue())}>
                        {label}
                    </span>
                </div>
            ))}
        </div>
    )
    const enableForm = (enabled: boolean) => {
        nameInput.disabled = !enabled
        emailInput.disabled = !enabled
        fields.classList.toggle("disabled", !enabled)
        consents.classList.toggle("disabled", !enabled)
    }
    const show = (label: string, state: string, enabled: boolean, hintText: string) => {
        buttonLabel.textContent = label
        button.className = Html.buildClassList("submit", state)
        button.disabled = !enabled
        hint.textContent = hintText
    }
    const render = () => {
        const now = Date.now() + serverOffset
        const left = Math.max(0, Math.floor((deadline - now) / 1000))
        const parts = [Math.floor(left / 86400), Math.floor(left / 3600) % 24, Math.floor(left / 60) % 60, left % 60]
        cells.forEach((cell, index) => cell.textContent = twoDigits(parts[index]))
        element.classList.toggle("closed", left === 0)
        const optProfile = service.projectProfileService.getValue()
        enableForm(left > 0 && optProfile.nonEmpty() && phase.type !== "busy" && phase.type !== "done")
        if (left === 0) {
            return show("Submissions closed · winners announced soon", "closed", false, "")
        }
        if (phase.type === "busy") {
            button.style.setProperty("--progress", phase.progress.toFixed(3))
            return show(`${phase.step} · ${Math.round(phase.progress * 100)}%`, "busy", false,
                "Please keep this tab open until the upload is complete.")
        }
        if (phase.type === "done") {
            return show(`Thank you. “${phase.projectName}” was received.`, "done", false,
                `Submission ${phase.id}. We will contact you by email if you win.`)
        }
        if (optProfile.isEmpty()) {
            return show("Open a project to submit", "disabled no-project", false,
                "Open your song in the studio, then come back to this page.")
        }
        const profile = optProfile.unwrap()
        const projectName = profile.meta.name
        const seconds = Contest.songSeconds(profile.project)
        if (seconds === 0) {
            return show(`“${projectName}” has no regions`, "disabled", false,
                "Place your song on the timeline, the mixdown renders from its regions.")
        }
        if (seconds > contest.maxSeconds) {
            return show(`“${projectName}” ends at ${clock(seconds)}, the limit is ${clock(contest.maxSeconds)}`,
                "disabled", false,
                `Your last region must end by ${clock(contest.maxSeconds)}. Reverb and delay tails may ring on.`)
        }
        if (blockedUntil > now) {
            const wait = Math.ceil((blockedUntil - now) / 1000)
            return show(`Next upload possible in ${twoDigits(Math.floor(wait / 3600))}:${twoDigits(Math.floor(wait / 60) % 60)}:${twoDigits(wait % 60)}`,
                "disabled", false, phase.type === "failed" ? phase.message : "")
        }
        const valid = formValid()
        if (phase.type === "failed") {
            return show("Upload failed · Try again", "failed", valid, phase.message)
        }
        return show(`Upload “${projectName}”`, valid ? "ready" : "disabled", valid,
            valid ? "" : "Fill in name and email and tick every box to upload.")
    }
    const startUpload = async () => {
        const optProfile = service.projectProfileService.getValue()
        if (optProfile.isEmpty() || !formValid() || phase.type === "busy") {return}
        const profile = optProfile.unwrap()
        const projectName = profile.meta.name
        phase = {type: "busy", step: "Bundling project", progress: 0}
        render()
        const entrant: Contest.Entrant = {name: nameInput.value.trim(), email: emailInput.value.trim()}
        const {status, value, error} = await Promises.tryCatch(Contest.submit(contest, profile, entrant,
            step => {
                if (phase.type === "busy") {phase = {...phase, step}}
                render()
            },
            progress => {
                if (phase.type === "busy") {phase = {...phase, progress}}
                render()
            }))
        if (status === "resolved") {
            phase = {type: "done", id: value, projectName}
        } else if (error instanceof Contest.Failure) {
            error.retryAfter.ifSome(seconds => blockedUntil = Date.now() + serverOffset + seconds * 1000)
            phase = {type: "failed", message: error.message}
        } else {
            console.warn(error)
            phase = {type: "failed", message: `Something went wrong while preparing your song (${String(error)}).`}
        }
        render()
    }
    const element: HTMLElement = (
        <div className="contest">
            <section className="hero">
                <ContestArt/>
                <div className="hero-content">
                    <div className="hero-text">
                        <BackButton lifecycle={lifecycle} service={service}/>
                        <span className="eyebrow">{contest.eyebrow}</span>
                        <h1><span className="year">{contest.name}</span><br/>{contest.title}</h1>
                        <p>{contest.intro}</p>
                    </div>
                    <div className="countdown">
                        <h3>Submissions Close In</h3>
                        <div className="cells">
                            {["Days", "Hours", "Minutes", "Seconds"].map((label, index) => (
                                <div>{cells[index]}<label>{label}</label></div>
                            ))}
                        </div>
                        <span className="deadline">{contest.deadlineLabel}</span>
                    </div>
                </div>
            </section>
            <div className="columns">
                <div className="column">
                    <section>
                        <h2>The Brief</h2>
                        <p>{contest.brief}</p>
                        <div className="bonus">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/>
                            </svg>
                            <p>{contest.bonus}</p>
                        </div>
                    </section>
                    <section>
                        <h2>Prizes</h2>
                        <div className="prizes">
                            {contest.prizes.map(({place, label, detail, url}) => (
                                <div className="prize">
                                    <span className="place">{place}</span>
                                    <span className="label">{label}</span>
                                    {isDefined(url)
                                        ? <a href={url} target="_blank" rel="noopener">{detail}</a>
                                        : <span className="detail">{detail}</span>}
                                </div>
                            ))}
                        </div>
                        <p className="note">{contest.prizeNote}</p>
                    </section>
                    <section>
                        <h2>Rules</h2>
                        <ol>{contest.rules.map(rule => <li>{rule}</li>)}</ol>
                    </section>
                </div>
                <div className="column">
                    <section>
                        <h2>Contest Terms</h2>
                        <div className="terms">{termsScroller}</div>
                    </section>
                    <section className="submit-section">
                        <h2>Submit Your Song</h2>
                        {fields}
                        {consents}
                        {button}
                        {hint}
                        <div className="footnote">
                            <span>We render an Opus mixdown and send it together with the project bundle.</span>
                            <span>Up to {Math.round(contest.maxBytes / 1048576)} MB · once per email every {contest.cooldownHours} hours</span>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    )
    const updateFades = () => {
        const {scrollTop, scrollHeight, clientHeight} = termsScroller
        termsScroller.classList.toggle("fade-top", scrollTop > 1)
        termsScroller.classList.toggle("fade-bottom", scrollTop + clientHeight < scrollHeight - 1)
    }
    const interval = setInterval(render, 1000)
    lifecycle.ownAll(
        {terminate: () => clearInterval(interval)},
        installScrollbars(termsScroller),
        service.projectProfileService.subscribe(render),
        ...consentModels.map(model => model.subscribe(render))
    )
    termsScroller.addEventListener("scroll", updateFades)
    nameInput.addEventListener("input", render)
    emailInput.addEventListener("input", render)
    button.addEventListener("click", startUpload)
    requestAnimationFrame(updateFades)
    render()
    return element
}

export const ContestPage: PageFactory<StudioService> = ({lifecycle, service, path}: PageContext<StudioService>) => {
    const name = path.substring(path.lastIndexOf("/") + 1)
    const element: HTMLElement = (
        <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
            <p className="message">Loading the contest…</p>
        </div>
    )
    const attempt = lifecycle.own(new Terminator())
    const load = async () => {
        attempt.terminate()
        const {status, value, error} = await Promises.tryCatch(Contest.load(name))
        if (status === "resolved") {
            return replaceChildren(element, <ContestContent lifecycle={attempt} service={service} contest={value}/>)
        }
        replaceChildren(element, (
            <div className="message">
                <BackButton lifecycle={attempt} service={service}/>
                <p>{error instanceof Contest.Failure ? error.message : `Could not load the contest (${String(error)}).`}</p>
                <button type="button" className="retry" onclick={() => {
                    replaceChildren(element, <p className="message">Loading the contest…</p>)
                    load().finally()
                }}>Try again</button>
            </div>
        ))
    }
    load().finally()
    return element
}
