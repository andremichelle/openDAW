export enum TrackRole {
    CLICK_GUIDE = "Click/Guide",
    DRUMS = "Drums",
    BASS = "Bass",
    GUITAR = "Guitar",
    VOCALS = "Vocals",
    BACKING_KEYS = "Backing/Keys"
}

export interface TrackData {
    id: string;
    filename: string;
    filepath: string;
    role: TrackRole;
    durationMs: number;
    initialOffsetMs: number;
}

export interface MarkerData {
    id: string;
    text: string;
    timeMs: number;
    durationMs: number;
    filepath: string;
    isEndAligned: boolean;
    isLoading?: boolean;
}

export interface SongData {
    path: string;
    title: string;
    tracks: TrackData[];
    guideMarkers?: MarkerData[];
}
