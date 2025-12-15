import * as fs from 'fs';
import * as path from 'path';
import { RoleDetector, TrackRole } from './RoleDetector';
import { v4 as uuidv4 } from 'uuid';

export interface TrackData {
    id: string;
    filename: string;
    filepath: string;
    role: TrackRole;
    durationMs: number; // To be filled by frontend or ffmpeg probe if possible
    initialOffsetMs: number;
}

export interface SongData {
    path: string;
    title: string;
    tracks: TrackData[];
}

export class SongLoader {
    static loadSong(songPath: string): SongData {
        const title = path.basename(songPath);
        const tracks: TrackData[] = [];

        const files = fs.readdirSync(songPath);
        const audioFiles = files.filter(f => /\.(mp3|wav|flac|ogg)$/i.test(f));

        for (const f of audioFiles) {
            const [role, bus] = RoleDetector.detectRole(f);
            tracks.push({
                id: uuidv4(),
                filename: f,
                filepath: path.join(songPath, f),
                role: role,
                durationMs: 0, // Frontend will determine this upon loading
                initialOffsetMs: 0
            });
        }

        return {
            path: songPath,
            title,
            tracks
        };
    }
}
