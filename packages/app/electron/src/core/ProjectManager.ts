import * as fs from 'fs';
import * as path from 'path';

export class ProjectManager {
    private projectRoot: string;
    private stagingDbPath: string;
    private globalCachePath: string;
    private exportsPath: string;

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
        this.stagingDbPath = path.join(projectRoot, "_StagingDB");
        this.globalCachePath = path.join(projectRoot, "_GlobalCache");
        this.exportsPath = path.join(projectRoot, "Exports");
    }

    ensureDirectories() {
        if (!fs.existsSync(this.stagingDbPath)) fs.mkdirSync(this.stagingDbPath, { recursive: true });
        if (!fs.existsSync(this.globalCachePath)) fs.mkdirSync(this.globalCachePath, { recursive: true });
        if (!fs.existsSync(this.exportsPath)) fs.mkdirSync(this.exportsPath, { recursive: true });
    }

    listProcessedSongs(): string[] {
        if (!fs.existsSync(this.stagingDbPath)) {
            return [];
        }
        const songs: string[] = [];
        const entries = fs.readdirSync(this.stagingDbPath);
        for (const name of entries) {
            const fullPath = path.join(this.stagingDbPath, name);
            if (fs.statSync(fullPath).isDirectory() && name.includes("__")) {
                songs.push(fullPath);
            }
        }
        return songs;
    }

    getGlobalCachePath(): string {
        return this.globalCachePath;
    }
}
