import {Project} from "@opendaw/studio-core"

export namespace ArmedCaptures {
    export const restore = (project: Project): void => {
        if (project.liveSync.nonEmpty()) {return}
        project.captureDevices.allCaptures()
            .filter(capture => capture.captureBox.armed.getValue())
            .forEach(capture => capture.armed.setValue(true))
    }
}
