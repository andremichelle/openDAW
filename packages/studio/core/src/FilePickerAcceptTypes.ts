export namespace FilePickerAcceptTypes {
    export const WavFiles: FilePickerOptions = {
        types: [{
            description: "wav-file",
            accept: {"audio/wav": [".wav"]}
        }]
    }
    export const SoundfontFiles: FilePickerOptions = {
        types: [{
            description: "soundfont-file",
            accept: {"audio/x-soundfont": [".sf2"]}
        }]
    }
    export const ProjectSyncLog: FilePickerOptions = {
        types: [{
            description: "openDAW sync-log-file",
            accept: {"application/octet-stream": [".odsl"]}
        }]
    }

    export const ProjectFileType: FilePickerAcceptType = {
        description: "openDAW project",
        accept: {"application/octet-stream": [".od"]}
    }

    export const PresetFileType: FilePickerAcceptType = {
        description: "openDAW preset",
        accept: {"application/octet-stream": [".odp"]}
    }

    export const ProjectBundleFileType: FilePickerAcceptType = {
        description: "openDAW project bundle",
        accept: {"application/octet-stream": [".odb"]}
    }

    export const ZipFileType: FilePickerAcceptType = {
        description: "zip file",
        accept: {"application/octet-stream": [".zip"]}
    }

    export const DawprojectFileType: FilePickerAcceptType = {
        description: "dawproject",
        accept: {"application/octet-stream": [".dawproject"]}
    }
    export const JsonFileType: FilePickerAcceptType = {
        description: "json",
        accept: {"application/json": [".json"]}
    }
}