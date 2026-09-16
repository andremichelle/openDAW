# Live Rooms

Live Rooms let you collaborate on a project in real time with other users. Everyone in the same room sees and edits the same project simultaneously.

## Creating or Joining a Room

Open the openDAW menu and select **Join Live Room...**. A dialog will ask for:

- **Room Name** -- lowercase letters, numbers, hyphens, dots, and underscores (max 16 characters). If no room with that name exists, a new one is created. If it already exists, you join the existing session.
- **Your Name** -- how other users will see you (max 16 characters).
- **Your Color** -- pick a color from the palette. This color identifies you in the room status bar and the chat.

The dialog shows a shareable join link (e.g. `https://opendaw.studio/join/my-room`). Click it to copy it to the clipboard and send it to anyone you want to invite.

You can also join directly by visiting a `/join/{roomName}` URL in your browser.

## Sharing Your Project

When you connect to an **empty room**, your current project is automatically published as the shared session. Everyone who joins afterwards receives a copy of that project state.

When you join a room that **already has participants**, you download the existing project from the room. Your local project is replaced by the shared one for the duration of the session.

## Room Lifecycle

- A room is created the moment the first user connects.
- The room stays open as long as at least one user is connected.
- There is no designated host. If the person who started the room leaves, everyone else continues collaborating normally.
- When the **last user leaves**, the room is scheduled for deletion after a short grace period (~60 seconds). If someone reconnects before the timeout, the room stays alive.
- After the timeout, the room and all its data are permanently deleted from the server.

**Rooms are transient.** Nothing is persisted on the server after the room closes. Make sure to save your project locally before leaving.

## Chat

While in a room, a chat tab appears on the right edge of the screen. Click it to open the chat overlay.

- Messages are visible to all users in the room.
- Each message shows the sender's name and color.
- Messages are synchronized through the room, so late joiners can see the conversation history from the current session.
- Like the room itself, the chat history is transient and disappears when the room closes.

## User Presence

A status bar shows all connected users with their name and color dot. Your pointer movement is tracked to indicate which panel you are currently working in, so other users can see where your focus is.

## Asset Sharing (Technical Details)

The server only synchronizes the project structure (tracks, devices, regions, automation, etc.) using a CRDT protocol. Binary assets like audio samples and soundfonts are **never stored on the server**.

Instead, assets are exchanged directly between users via **peer-to-peer (P2P)** connections:

1. When a user needs an asset they do not have locally, a request is broadcast to all peers in the room.
2. Any peer that has the asset responds and a direct WebRTC data channel is established.
3. The asset is transferred in chunks directly between browsers.
4. Once received, the asset is stored in the user's local browser storage (OPFS) for future use.

This means your audio files and soundfonts remain private to the participants of the room and are never uploaded to or stored on any server.
