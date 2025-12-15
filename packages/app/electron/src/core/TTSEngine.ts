import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

export class TTSEngine {
    constructor(private apiKey: string) {}

    async generateGuideCue(text: string, outputPath: string, modelId: string = "eleven_multilingual_v2", voiceId: string = "RKCbSROXui75bk1SVpy8"): Promise<boolean> {
        if (!this.apiKey) return false;

        const options = {
            method: 'POST',
            hostname: 'api.elevenlabs.io',
            path: `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
            headers: {
                'xi-api-key': this.apiKey,
                'Content-Type': 'application/json'
            }
        };

        return new Promise((resolve) => {
            const req = https.request(options, (res) => {
                if (res.statusCode !== 200) {
                    console.error(`ElevenLabs API Error: ${res.statusCode}`);
                    resolve(false);
                    return;
                }

                const file = fs.createWriteStream(outputPath);
                res.pipe(file);

                file.on('finish', () => {
                    file.close();
                    resolve(true);
                });
            });

            req.on('error', (e) => {
                console.error(e);
                resolve(false);
            });

            req.write(JSON.stringify({
                text: text,
                model_id: modelId,
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            }));
            req.end();
        });
    }
}
