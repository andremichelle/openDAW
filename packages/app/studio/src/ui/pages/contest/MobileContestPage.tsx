import css from "./MobileContestPage.sass?inline"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {int, isDefined} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Contest} from "./Contest"
import {ContestArt} from "./ContestArt"

const className = Html.adoptStyleSheet(css, "MobileContestPage")

const twoDigits = (value: int): string => String(value).padStart(2, "0")

const MobileContestContent = ({contest}: { contest: Contest.Definition }) => {
    const serverOffset = contest.serverTime - Date.now()
    const deadline = Date.parse(contest.deadline)
    const cells: ReadonlyArray<HTMLElement> = ["Days", "Hours", "Minutes", "Seconds"].map(() => <span/>)
    const element: HTMLElement = (
        <div className="contest">
            <section className="hero">
                <ContestArt/>
                <div className="hero-content">
                    <div className="hero-text">
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
                    <section className="desktop-note">
                        <h2>Submit From A Computer</h2>
                        <p>openDAW is a full music studio and needs the screen space of a computer. Make your song in a desktop or laptop browser and submit it from this page there.</p>
                    </section>
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
                    <section>
                        <h2>Contest Terms</h2>
                        <div className="terms">
                            <div className="scroller">
                                {contest.terms.sections.map(({heading, text}) => (
                                    <div><h4>{heading}</h4><p>{text}</p></div>
                                ))}
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    )
    const render = () => {
        const left = Math.max(0, Math.floor((deadline - Date.now() - serverOffset) / 1000))
        const parts = [Math.floor(left / 86400), Math.floor(left / 3600) % 24, Math.floor(left / 60) % 60, left % 60]
        cells.forEach((cell, index) => cell.textContent = twoDigits(parts[index]))
        element.classList.toggle("closed", left === 0)
    }
    setInterval(render, 1000)
    render()
    return element
}

export const mountMobileContestPage = (target: HTMLElement, name: string): void => {
    const element: HTMLElement = (
        <div className={className}>
            <p className="message">Loading the contest…</p>
        </div>
    )
    replaceChildren(target, element)
    const load = async () => {
        const {status, value, error} = await Promises.tryCatch(Contest.load(name))
        if (status === "resolved") {
            return replaceChildren(element, <MobileContestContent contest={value}/>)
        }
        replaceChildren(element, (
            <div className="message">
                <p>{error instanceof Contest.Failure ? error.message : `Could not load the contest (${String(error)}).`}</p>
                <button type="button" className="retry" onclick={() => {
                    replaceChildren(element, <p className="message">Loading the contest…</p>)
                    load().finally()
                }}>Try again</button>
            </div>
        ))
    }
    load().finally()
}
