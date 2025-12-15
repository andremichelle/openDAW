export class SimpleAudioEngine {
    private context: AudioContext;
    private masterGain: GainNode;
    private trackNodes: Map<string, { source: AudioBufferSourceNode | null, gain: GainNode, buffer: AudioBuffer }>;
    private startTime: number = 0;
    private pauseTime: number = 0;
    private isPlaying: boolean = false;

    constructor() {
        this.context = new AudioContext();
        this.masterGain = this.context.createGain();
        this.masterGain.connect(this.context.destination);
        this.trackNodes = new Map();
    }

    addTrack(id: string, buffer: AudioBuffer) {
        const gain = this.context.createGain();
        gain.connect(this.masterGain);
        this.trackNodes.set(id, { source: null, gain, buffer });
    }

    removeTrack(id: string) {
        const track = this.trackNodes.get(id);
        if (track) {
            track.gain.disconnect();
            if (track.source) track.source.stop();
            this.trackNodes.delete(id);
        }
    }

    play() {
        if (this.isPlaying) return;

        if (this.context.state === 'suspended') {
            this.context.resume();
        }

        const offset = this.pauseTime;
        this.startTime = this.context.currentTime - offset;

        this.trackNodes.forEach(track => {
            const source = this.context.createBufferSource();
            source.buffer = track.buffer;
            source.connect(track.gain);
            source.start(0, offset);
            track.source = source;
        });

        this.isPlaying = true;
    }

    pause() {
        if (!this.isPlaying) return;

        this.trackNodes.forEach(track => {
            if (track.source) {
                track.source.stop();
                track.source = null;
            }
        });

        this.pauseTime = this.context.currentTime - this.startTime;
        this.isPlaying = false;
    }

    seek(timeSeconds: number) {
        const wasPlaying = this.isPlaying;
        if (wasPlaying) this.pause();
        this.pauseTime = timeSeconds;
        if (wasPlaying) this.play();
    }

    setTrackVolume(id: string, volume: number) {
        const track = this.trackNodes.get(id);
        if (track) {
            track.gain.gain.value = volume;
        }
    }

    getCurrentTime(): number {
        if (this.isPlaying) {
            return this.context.currentTime - this.startTime;
        }
        return this.pauseTime;
    }

    clear() {
        this.pause();
        this.trackNodes.clear();
    }
}
