import {Field, PrimitiveField, StringField} from "@opendaw/lib-box"
import {Promises} from "@opendaw/lib-runtime"
import {EffectFactories, PresetStorage, ProjectMeta, ProjectStorage, SampleStorage, SoundfontStorage} from "@opendaw/studio-core"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {isDefined, Optional} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService"
import {AwarenessUserState, readIdentity} from "@/service/RoomAwareness"

// Every user-given name the app knows, longest first so a name containing another one is blanked whole.
export namespace ReportNames {
    const MinLength = 3
    const Letter = /\p{L}/u

    const defaultNames = (): ReadonlySet<string> => new Set([
        ...Object.values(InstrumentFactories.Named), ...Object.values(EffectFactories.MergedNamed)
    ].map(factory => factory.defaultName))

    const isUserName = (name: string, defaults: ReadonlySet<string>): boolean =>
        name.length >= MinLength && Letter.test(name) && !defaults.has(name)

    const metaStrings = (meta: ProjectMeta): ReadonlyArray<string> =>
        [meta.name, meta.artist, meta.description, meta.notepad ?? "", ...meta.tags]

    const collectFields = (fields: ReadonlyArray<Field>, names: Array<string>): void =>
        fields.forEach(field => field.accept({
            visitArrayField: field => collectFields(field.fields(), names),
            visitObjectField: field => collectFields(field.fields(), names),
            visitPrimitiveField: (field: PrimitiveField) => {
                if (field instanceof StringField) {names.push(field.getValue())}
            }
        }))

    const settled = async (provider: () => Promise<ReadonlyArray<string>>): Promise<ReadonlyArray<string>> => {
        const result = await Promises.tryCatch(provider())
        return result.status === "resolved" ? result.value : []
    }

    export const collectNames = async (service: StudioService): Promise<ReadonlyArray<string>> => {
        const names: Array<string> = []
        service.projectProfileService.getValue().ifSome(({meta, project}) => {
            names.push(...metaStrings(meta))
            project.boxGraph.boxes().forEach(box => collectFields(box.fields(), names))
        })
        names.push(...PresetStorage.observable().getValue().flatMap(preset => [preset.name, preset.description]))
        names.push(readIdentity().name)
        const room = service.roomAwareness.getValue()
        if (isDefined(room)) {
            names.push(room.roomName, room.name.getValue())
            room.awareness.getStates().forEach(state => {
                const user: Optional<AwarenessUserState> = state.user
                if (isDefined(user)) {names.push(user.name)}
            })
        }
        const sources = await Promise.all([
            settled(async () => (await ProjectStorage.listProjects()).flatMap(({meta}) => metaStrings(meta))),
            settled(async () => (await SampleStorage.get().list()).map(sample => sample.name)),
            settled(async () => (await SoundfontStorage.get().list()).map(soundfont => soundfont.name))
        ])
        sources.forEach(source => names.push(...source))
        const defaults = defaultNames()
        return Array.from(new Set(names.map(name => name.trim()).filter(name => isUserName(name, defaults))))
            .sort((left, right) => right.length - left.length)
    }
}
