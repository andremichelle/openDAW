# StageTraxx Tools (Powered by openDAW)

This is a standalone Electron desktop application designed for Auto-Staging and Library Management, built using the visual rendering engine of openDAW.

## Features

- **Librarian:** Scan your local library (`_StagingDB`) and manage songs.
- **Workbench:** Visualize stems, mute/solo tracks, and manage playback.
- **Markers & TTS:** Add guide markers (Count-in, Verse, Chorus) and generate TTS cues via ElevenLabs API.
- **Standalone:** Runs locally on your machine with direct file system access.

## Prerequisites

- **Node.js**: Version 20 or higher (Repo requires >=23 for some parts, but 20+ usually works for Electron).
- **Git**

## Installation (From Scratch)

1.  **Clone the Repository**
    ```bash
    git clone <repository_url>
    cd opendaw
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

## Development & Debugging

To run the application in development mode (with Hot Module Replacement for the UI):

1.  **Start the Dev Server**
    ```bash
    npm run dev:electron
    ```
    This command runs two processes concurrently:
    -   The Vite dev server for the frontend (`https://localhost:8080`).
    -   The Electron main process, which loads the dev server.

    *Note: You might see SSL warnings in the console due to self-signed certificates, which are ignored by the Electron main process configuration.*

## Building for Production

To build the application into an executable (`.exe`, `.dmg`, `.AppImage`):

1.  **Build the Source Code**
    ```bash
    npm run build:electron
    ```
    This compiles the TypeScript backend and builds the React frontend.

2.  **Package the Application**
    ```bash
    cd packages/app/electron
    npm run package
    ```
    The output binaries will be in `packages/app/electron/release`.

## Configuration

- **Project Root:** Set the root directory of your Staging Database in the "Librarian" tab.
- **ElevenLabs API:** Enter your API Key in the settings to enable TTS generation.
