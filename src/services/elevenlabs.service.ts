import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/index.js";

export class ElevenLabsService {
  constructor(private readonly config: AppConfig) {}

  async transcribeAudio(buffer: Buffer, filename: string): Promise<string> {
    const params = new URLSearchParams();
    if (this.config.elevenLabsEnableZeroRetention) {
      params.set("enable_logging", "false");
    }

    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", new Blob([new Uint8Array(buffer)]), filename);

    const url = `https://api.elevenlabs.io/v1/speech-to-text${params.size ? `?${params}` : ""}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.config.elevenLabsApiKey,
      },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs transcription failed: ${response.status}`);
    }

    const data = (await response.json()) as { text?: string };
    if (!data.text?.trim()) {
      throw new Error("Empty transcription result");
    }
    return data.text.trim();
  }

  writeTempFile(buffer: Buffer, mediaId: string): string {
    mkdirSync(this.config.tempAudioDir, { recursive: true });
    const path = join(this.config.tempAudioDir, `${mediaId}.ogg`);
    writeFileSync(path, buffer);
    return path;
  }

  deleteTempFile(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // ignore missing temp files
    }
  }
}
