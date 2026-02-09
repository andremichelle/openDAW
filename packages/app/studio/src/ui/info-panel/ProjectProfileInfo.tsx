import css from "./ProjectInfo.sass?inline"
import {
    DefaultObservableValue,
    isDefined,
    isUndefined,
    Lifecycle,
    MutableObservableOption,
    RuntimeNotifier
} from "@opendaw/lib-std"
import { createElement, Inject } from "@opendaw/lib-jsx"
import { StudioService } from "@/service/StudioService.ts"
import { Cover } from "./Cover"
import { Events, Html } from "@opendaw/lib-dom"
import { Button } from "@/ui/components/Button"
import { Colors } from "@opendaw/studio-enums"
import { PublishMusic } from "@/ui/info-panel/PublishMusic"
import { Promises } from "@opendaw/lib-runtime"

const className = Html.adoptStyleSheet(css, "ProjectInfo")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ProjectProfileInfo = ({ lifecycle, service }: Construct) => {
    if (!service.hasProfile) { return "No project profile." }
    const { profile } = service
    const { meta, cover } = profile
    const inputName: HTMLInputElement = (
        <input type="text" className="default"
            aria-label="Project Name"
            placeholder="Type in your project name"
            value={meta.name} />
    )
    const inputArtist: HTMLInputElement = (
        <input type="text" className="default"
            aria-label="Artist Name"
            placeholder="Type in your artist name"
            value={meta.artist} />
    )
    const inputTags: HTMLInputElement = (
        <input type="text" className="default"
            aria-label="Project Tags"
            placeholder="Type in your project tags"
            value={meta.tags.join(", ")} />
    )
    const inputDescription: HTMLTextAreaElement = (
        <textarea className="default"
            aria-label="Project Description"
            placeholder="Type in your project description"
            value={meta.description} />
    )
    const coverModel = new MutableObservableOption<ArrayBuffer>(cover.unwrapOrUndefined())
    const buttonPublishText = Inject.value(isDefined(meta.radioToken) ? "Republish" : "Publish")
    const unpublishButton: HTMLElement = (
        <Button lifecycle={lifecycle}
            className={isDefined(meta.radioToken) ? undefined : "hidden"}
            onClick={async () => {
                const approved = await RuntimeNotifier.approve({
                    headline: "Unpublish Project?",
                    message: "You can publish later again."
                })
                if (!approved) { return }
                const { status, error } = await Promises.tryCatch(PublishMusic.deleteMusic(meta.radioToken ?? ""))
                if (status === "rejected") {
                    return await RuntimeNotifier.info({
                        headline: "Could not unpublish",
                        message: String(error)
                    })
                }
                unpublishButton.classList.toggle("hidden", true)
                buttonPublishText.value = "Publish"
                delete meta.radioToken
                const saveResult = await Promises.tryCatch(profile.save())
                if (saveResult.status === "rejected") {
                    return await RuntimeNotifier.info({
                        headline: "Could not save profile",
                        message: String(saveResult.error)
                    })
                }
                return await RuntimeNotifier.info({
                    headline: "Project unpublished",
                    message: ""
                })
            }}>
            Delete
        </Button>
    )
    const form: HTMLElement = (
        <div className="form">
            <div className="label">Name</div>
            <label info="Maximum 128 characters">{inputName}</label>
            <div className="label">Artist</div>
            <label info="Maximum 128 characters">{inputArtist}</label>
            <div className="label">Tags</div>
            <label info="Separate tags with commas">{inputTags}</label>
            <div className="label">Description</div>
            <label info="Maximum 512 characters">{inputDescription}</label>
            <div className="label">Cover</div>
            <Cover lifecycle={lifecycle} model={coverModel} />
            <div className="experimental-section" style={{ display: "contents" }}>
                <div className="label" />
                <div style={{ display: "flex", flexDirection: "column", rowGap: "1em" }}>
                    <div>
                        Publish your music to <a href="https://music.opendaw.studio"
                            style={{ color: Colors.cyan.toString() }}
                            target="music.opendaw.studio"
                            rel="noopener noreferrer">our music
                            page</a>
                    </div>
                    <div style={{ display: "flex", columnGap: "1em" }}>
                        <Button lifecycle={lifecycle}
                            onClick={async () => {
                                // Save current input values before dialog steals focus
                                profile.updateMetaData("name", inputName.value)
                                profile.updateMetaData("artist", inputArtist.value)
                                profile.updateMetaData("tags", inputTags.value.split(",").map(x => x.trim()))
                                profile.updateMetaData("description", inputDescription.value)
                                const approved = await RuntimeNotifier.approve({
                                    headline: "Publish Your Music",
                                    message: `Ensure all samples, soundfonts, and images are cleared of copyright.
                                    Publishing makes your entire track visible to everyone.
                                    Prepare proper metadata and upload a cover before starting.
                                    
                                    You are responsible for all content you share.
                                    
                                    All music is then published under CC BY-NC-SA 4.0`
                                })
                                if (!approved) { return }
                                const saveResult = await Promises.tryCatch(profile.save())
                                if (saveResult.status === "rejected") {
                                    return RuntimeNotifier.info({
                                        headline: "Problem",
                                        message: String(saveResult.error)
                                    })
                                }
                                const progressValue = new DefaultObservableValue(0.0)
                                const dialog = RuntimeNotifier.progress({
                                    headline: "Publishing Music",
                                    progress: progressValue
                                })
                                const { status, error } = await Promises.tryCatch(PublishMusic
                                    .publishMusic(profile,
                                        progress => progressValue.setValue(progress),
                                        message => dialog.message = message))
                                dialog.terminate()
                                if (status === "rejected") {
                                    return await RuntimeNotifier.info({
                                        headline: "Could not publish",
                                        message: String(error)
                                    })
                                }
                                unpublishButton.classList.toggle("hidden", isUndefined(meta.radioToken))
                                buttonPublishText.value = "Republish"
                                const result = await Promises.tryCatch(profile.save())
                                if (result.status === "rejected") {
                                    console.error("Publish failed", result.error)
                                    return await RuntimeNotifier.info({ headline: "Publish failed", message: result.error instanceof Error ? result.error.message : String(result.error) })
                                }
                                return await RuntimeNotifier.info({ headline: "Publish complete", message: "" })
                            }}
                            appearance={{ framed: true, color: Colors.cyan }}>
                            {buttonPublishText}
                        </Button>
                        {unpublishButton}
                    </div>
                </div>
            </div>
        </div>
    )
    lifecycle.ownAll(
        Events.subscribe(form, "keydown", (event: KeyboardEvent) => {
            if (event.code === "Enter" && event.target instanceof HTMLInputElement) { event.target.blur() }
        }),
        Events.subscribe(inputName, "blur",
            () => profile.updateMetaData("name", inputName.value)),
        Events.subscribe(inputArtist, "blur",
            () => profile.updateMetaData("artist", inputArtist.value)),
        Events.subscribe(inputDescription, "blur",
            () => profile.updateMetaData("description", inputDescription.value)),
        Events.subscribe(inputTags, "blur",
            () => profile.updateMetaData("tags", inputTags.value.split(",").map(x => x.trim()))),
        Events.subscribe(inputName, "input", () => Html.limitChars(inputName, "value", 128)),
        Events.subscribe(inputDescription, "input", () => Html.limitChars(inputDescription, "value", 512)),
        coverModel.subscribe(owner => profile.updateCover(owner))
    )
    return (
        <div className={className}>
            {form}
        </div>
    )
}