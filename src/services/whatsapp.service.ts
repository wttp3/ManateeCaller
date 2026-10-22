import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/index.js";
import {
  OPT_OUT_REFUSED_MESSAGE,
  OUTBOUND_REFUSED_MESSAGE,
  OptOutSendRefusedError,
  PilotSendRefusedError,
  isPilotSenderAllowed,
  maskPhone,
} from "../pilot/allowlist.js";
import { ParticipantService } from "./participant.service.js";
import { decryptString } from "../utils/crypto.js";
import { logInfo } from "../utils/logger.js";

export class WhatsAppService {
  constructor(private readonly config: AppConfig) {}

  private baseUrl(): string {
    return `https://graph.facebook.com/${this.config.whatsappApiVersion}/${this.config.whatsappPhoneNumberId}`;
  }

  async sendText(toPhone: string, body: string, options?: { bypassOptOut?: boolean }): Promise<void> {
    await this.postMessage(
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: toPhone.replace(/^\+/, ""),
        type: "text",
        text: { body },
      },
      options,
    );
  }

  async sendTemplate(toPhone: string, templateName: string): Promise<void> {
    await this.postMessage({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone.replace(/^\+/, ""),
      type: "template",
      template: {
        name: templateName,
        language: { code: "en_GB" },
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: "ManateeCaller" }],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{ type: "payload", payload: "IM_IN" }],
          },
        ],
      },
    });
  }

  async deleteMedia(mediaId: string): Promise<void> {
    const url = `https://graph.facebook.com/${this.config.whatsappApiVersion}/${mediaId}?phone_number_id=${this.config.whatsappPhoneNumberId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.config.whatsappAccessToken}` },
    });
    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Failed to delete media: ${response.status} ${detail.slice(0, 300)}`);
    }
  }

  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const metaUrl = `https://graph.facebook.com/${this.config.whatsappApiVersion}/${mediaId}`;
    const metaResponse = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${this.config.whatsappAccessToken}` },
    });
    if (!metaResponse.ok) {
      throw new Error(`Failed to fetch media metadata: ${metaResponse.status}`);
    }
    const meta = (await metaResponse.json()) as { url?: string; mime_type?: string };
    if (!meta.url) {
      throw new Error("Media URL missing");
    }

    const fileResponse = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${this.config.whatsappAccessToken}` },
    });
    if (!fileResponse.ok) {
      throw new Error(`Failed to download media: ${fileResponse.status}`);
    }

    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    return { buffer, mimeType: meta.mime_type ?? "application/octet-stream" };
  }

  /**
   * Meta signs the raw entity bytes. Compare those bytes, not a parsed
   * and re-serialised JSON value.
   */
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!Buffer.isBuffer(rawBody) || !signatureHeader?.startsWith("sha256=")) {
      return false;
    }
    const receivedHex = signatureHeader.slice("sha256=".length);
    if (!/^[0-9a-fA-F]{64}$/.test(receivedHex)) {
      return false;
    }
    const expected = createHmac("sha256", this.config.whatsappAppSecret).update(rawBody).digest();
    const received = Buffer.from(receivedHex, "hex");
    return timingSafeEqual(expected, received);
  }

  decryptPhone(encryptedPhone: string): string {
    return decryptString(encryptedPhone, this.config.dataEncryptionKey);
  }

  private async postMessage(
    payload: Record<string, unknown>,
    options?: { bypassOptOut?: boolean },
  ): Promise<void> {
    await this.assertRecipientAllowed(payload.to, options);
    const response = await fetch(`${this.baseUrl()}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.whatsappAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WhatsApp send failed: ${response.status} ${text.slice(0, 200)}`);
    }
  }

  /**
   * Hard guard: nothing leaves the process for a number outside the allowlist,
   * or for an opted-out or blocked participant. The single opt-out or erasure
   * confirmation sets bypassOptOut; the allowlist still applies.
   */
  private async assertRecipientAllowed(to: unknown, options?: { bypassOptOut?: boolean }): Promise<void> {
    if (typeof to !== "string" || !isPilotSenderAllowed(to, this.config.pilotAllowedSenders)) {
      logInfo(OUTBOUND_REFUSED_MESSAGE, {
        to: typeof to === "string" ? maskPhone(to) : "••••",
      });
      throw new PilotSendRefusedError();
    }
    if (options?.bypassOptOut) {
      return;
    }

    const participants = new ParticipantService(this.config);
    const lookupHash = participants.phoneLookupHash(to);
    const [suppressed, participant] = await Promise.all([
      participants.isSuppressed(lookupHash),
      participants.getParticipantByLookup(lookupHash),
    ]);
    if (suppressed || participant?.status === "opted_out" || participant?.status === "blocked") {
      logInfo(OPT_OUT_REFUSED_MESSAGE, { to: maskPhone(to) });
      throw new OptOutSendRefusedError();
    }
  }
}
