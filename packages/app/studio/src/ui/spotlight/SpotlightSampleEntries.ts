import {Option} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {Sample} from "@opendaw/studio-adapters"
import {SampleStorage} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"
import {OpenSampleAPI} from "@/opendaw-api"
import {createTapeTracks} from "@/ui/browse/SampleSelection"
import {SpotlightEntry} from "@/ui/spotlight/SpotlightEntry"
import {SpotlightSampleFilter} from "@/ui/spotlight/SpotlightSampleFilter"

export type SpotlightSample = { readonly sample: Sample, readonly local: boolean }

export namespace SpotlightSampleEntries {
    export const load = async (): Promise<ReadonlyArray<SpotlightSample>> => {
        const [cloud, stored] = await Promise.all([
            OpenSampleAPI.get().all().catch(() => []),
            SampleStorage.get().list().catch(() => [])
        ])
        const cloudIds = new Set(cloud.map(({uuid}) => uuid))
        return [
            ...cloud.map(sample => ({sample, local: false})),
            ...stored.filter(({uuid}) => !cloudIds.has(uuid)).map(sample => ({sample, local: true}))
        ]
    }

    export const collect = (service: StudioService, samples: ReadonlyArray<SpotlightSample>): ReadonlyArray<SpotlightEntry> =>
        samples.map(({sample, local}) => ({
            verb: "sample",
            label: `Sample · ${sample.name}`,
            names: [sample.name],
            qualifiers: [sample.bpm > 0 ? SpotlightSampleFilter.Loop : SpotlightSampleFilter.OneShot],
            icon: IconSymbol.AudioFile,
            detail: [sample.bpm > 0 ? `${Math.round(sample.bpm)} BPM` : "", `${sample.duration.toFixed(1)} s`,
                local ? "Local" : "openDAW"].filter(text => text.length > 0).join(" · "),
            group: 0,
            disabled: Option.None,
            children: [],
            run: () => createTapeTracks(service, [sample]).catch((reason: unknown) => console.warn(reason))
        }))
}
