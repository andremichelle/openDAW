export enum TrackRole {
    CLICK_GUIDE = "Click/Guide",
    DRUMS = "Drums",
    BASS = "Bass",
    GUITAR = "Guitar",
    VOCALS = "Vocals",
    BACKING_KEYS = "Backing/Keys"
}

export class RoleDetector {
    static detectRole(filename: string): [TrackRole, number] {
        const lowerName = filename.toLowerCase();

        // Priority 1: Click/Guide -> Bus 1 (Index 0)
        if (["(click)", "_click", "(guide)", "_guide"].some(x => lowerName.includes(x))) {
            return [TrackRole.CLICK_GUIDE, 0];
        }

        // Priority 2: Drums -> Bus 2 (Index 1)
        if (["(drums)", "_drums", "(drum)", "_drum"].some(x => lowerName.includes(x))) {
            return [TrackRole.DRUMS, 1];
        }

        // Priority 3: Bass -> Bus 3 (Index 2)
        if (["(bass)", "_bass"].some(x => lowerName.includes(x))) {
            return [TrackRole.BASS, 2];
        }

        // Priority 4: Guitar -> Bus 4 (Index 3)
        if (["(guitar)", "_guitar", "(gtr)", "_gtr"].some(x => lowerName.includes(x))) {
            return [TrackRole.GUITAR, 3];
        }

        // Priority 5: Vocals -> Bus 5 (Index 4)
        if (["(vox)", "_vox", "(vocals)", "_vocals"].some(x => lowerName.includes(x))) {
            return [TrackRole.VOCALS, 4];
        }

        // Priority 6: Backing/Keys -> Bus 5 (Index 4)
        return [TrackRole.BACKING_KEYS, 4];
    }
}
