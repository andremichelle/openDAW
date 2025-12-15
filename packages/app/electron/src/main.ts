import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';
import { ProjectManager } from './core/ProjectManager';
import { SongLoader } from './core/SongLoader';
import { TTSEngine } from './core/TTSEngine';

interface StoreSchema {
    projectRoot: string;
    elevenLabsKey: string;
    elevenLabsModel: string;
    elevenLabsVoice: string;
}

const store = new Store<StoreSchema>({
    defaults: {
        projectRoot: app.getPath('home'),
        elevenLabsKey: '',
        elevenLabsModel: 'eleven_multilingual_v2',
        elevenLabsVoice: 'RKCbSROXui75bk1SVpy8'
    }
});

let mainWindow: BrowserWindow | null = null;

// Allow self-signed certs for localhost
app.commandLine.appendSwitch('ignore-certificate-errors');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false // Allow loading local files
    },
  });

  // In development, load from Vite server
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:8080/index_standalone.html');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load the built file
    // __dirname is usually 'packages/app/electron/dist'
    // We need to go up to 'packages/app/studio/dist'
    // ../../studio/dist/index_standalone.html
    mainWindow.loadFile(path.join(__dirname, '../../studio/dist/index_standalone.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (mainWindow === null) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('get-settings', () => {
    return store.store;
});

ipcMain.handle('save-settings', (event, settings: Partial<StoreSchema>) => {
    store.set(settings);
    return true;
});

ipcMain.handle('select-directory', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

ipcMain.handle('scan-projects', () => {
    const root = store.get('projectRoot');
    if (!root) throw new Error("Project Root not set");
    const pm = new ProjectManager(root);
    pm.ensureDirectories();
    return pm.listProcessedSongs().map(p => {
        // Read manifest if exists
        const manifestPath = path.join(p, "song_manifest.json");
        let title = path.basename(p);
        let id = "";
        if (fs.existsSync(manifestPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                if (data.title) title = data.title;
                if (data.id) id = data.id;
            } catch (e) {
                console.error("Failed to read manifest", e);
            }
        }
        return { path: p, title, id };
    });
});

ipcMain.handle('load-song-details', (event, songPath: string) => {
    return SongLoader.loadSong(songPath);
});

ipcMain.handle('tts:generate', async (event, { text, outputPath }) => {
    const key = store.get('elevenLabsKey');
    const model = store.get('elevenLabsModel') || "eleven_multilingual_v2";
    const voice = store.get('elevenLabsVoice') || "RKCbSROXui75bk1SVpy8";

    if (!key) throw new Error("ElevenLabs API Key is missing");

    const tts = new TTSEngine(key);
    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    return await tts.generateGuideCue(text, outputPath, model, voice);
});

ipcMain.handle('get-global-cache-path', () => {
    const root = store.get('projectRoot');
    if (!root) throw new Error("Project Root not set");
    const pm = new ProjectManager(root);
    return pm.getGlobalCachePath();
});

ipcMain.handle('get-song-local-cache-path', (event, songPath: string) => {
    // raw_guides inside song folder
    return path.join(songPath, "raw_guides");
});
