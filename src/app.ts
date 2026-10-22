import express, { type Express, type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config/index.js";
import { redactConfig } from "./config/index.js";
import { resolvePublicDir } from "./utils/runtime-paths.js";
import { ParticipantService } from "./services/participant.service.js";
import { ArtworkService } from "./services/participant.service.js";
import { InterviewService } from "./services/interview.service.js";
import { JobService } from "./services/job.service.js";
import { WhatsAppService } from "./services/whatsapp.service.js";
import { INBOUND_IGNORED_MESSAGE, isPilotSenderAllowed, maskPhone } from "./pilot/allowlist.js";
import { normalizePhone } from "./utils/phone.js";
import { safeEqualText } from "./utils/crypto.js";
import { logError, logInfo } from "./utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolvePublicDir(__dirname);

export function createApp(config: AppConfig): Express {
  const app = express();
  const participants = new ParticipantService(config);
  const artwork = new ArtworkService(config);
  const interview = new InterviewService(config);
  const jobs = new JobService(config);
  const whatsapp = new WhatsAppService(config);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 200,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get("/health", (_req, res) => {
    const sha = process.env.DEPLOY_COMMIT_SHA;
    res.json({
      ok: true,
      sha: sha && sha.length > 0 ? sha : null,
      config: redactConfig(config),
    });
  });

  app.use(express.static(publicDir));

  app.post(
    "/api/signup",
    express.json(),
    rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }),
    async (req, res) => {
      try {
        const body = req.body as {
          name?: string;
          phone?: string;
          whatsappConsent?: boolean;
          voiceConsent?: boolean;
          privacyAccepted?: boolean;
          ageConfirmed?: boolean;
        };

        const result = await participants.createParticipant({
          name: body.name ?? "",
          phone: body.phone ?? "",
          whatsappConsent: Boolean(body.whatsappConsent),
          voiceConsent: Boolean(body.voiceConsent),
          privacyAccepted: Boolean(body.privacyAccepted),
          ageConfirmed: Boolean(body.ageConfirmed),
        });

        res.status(201).json({
          ok: true,
          sessionId: result.sessionId,
          participantId: result.participantId,
          delivery: config.whatsappTemplateInvitesEnabled ? "template" : "keyword",
          optInKeyword: config.optInKeyword,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Signup failed";
        res.status(400).json({ ok: false, error: message });
      }
    },
  );

  app.get("/api/mosaic", async (_req, res) => {
    const tiles = await artwork.listTiles();
    res.json({ tiles });
  });

  app.post(
    "/api/erasure",
    express.json(),
    rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }),
    async (req, res) => {
      if (!config.erasureAdminToken) {
        res.sendStatus(404);
        return;
      }
      const header = req.header("authorization") ?? "";
      const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
      if (!safeEqualText(provided, config.erasureAdminToken)) {
        res.sendStatus(401);
        return;
      }
      try {
        const { participantId } = req.body as { participantId?: string };
        if (!participantId) {
          res.status(400).json({ ok: false, error: "participantId required" });
          return;
        }
        await interview.eraseParticipant(participantId);
        res.json({ ok: true });
      } catch (err) {
        logError("Erasure failed", { error: err instanceof Error ? err.message : "unknown" });
        res.status(500).json({ ok: false, error: "Erasure failed" });
      }
    },
  );

  app.get("/webhook/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === config.whatsappWebhookVerifyToken) {
      res.status(200).send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  app.post(
    "/webhook/whatsapp",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-hub-signature-256"] as string | undefined;

      if (!whatsapp.verifySignature(rawBody, signature)) {
        res.sendStatus(403);
        return;
      }

      res.sendStatus(200);

      try {
        const payload = JSON.parse(rawBody.toString("utf8")) as {
          entry?: Array<{
            changes?: Array<{
              value?: {
                messages?: Array<{
                  id: string;
                  from: string;
                  type: string;
                  text?: { body?: string };
                  audio?: { id?: string };
                  button?: { payload?: string };
                  interactive?: { button_reply?: { id?: string } };
                }>;
              };
            }>;
          }>;
        };

        for (const entry of payload.entry ?? []) {
          for (const change of entry.changes ?? []) {
            for (const message of change.value?.messages ?? []) {
              const from = normalizePhone(typeof message.from === "string" ? message.from : "");
              if (!isPilotSenderAllowed(from, config.pilotAllowedSenders)) {
                logInfo(INBOUND_IGNORED_MESSAGE, { from: maskPhone(from) });
                continue;
              }

              const eventKey = `msg:${message.id}`;
              const isNew = await jobs.recordWebhook(eventKey, message, participants.phoneLookupHash(from));
              if (!isNew) {
                continue;
              }

              await interview.handleInboundMessage({
                from,
                type: message.type,
                text: message.text?.body,
                buttonReplyId:
                  message.button?.payload ??
                  message.interactive?.button_reply?.id,
                mediaId: message.audio?.id,
                messageId: message.id,
              });
            }
          }
        }
      } catch (err) {
        logError("Webhook processing failed", {
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    },
  );

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logError("Unhandled error", { error: err.message });
    res.status(500).json({ ok: false, error: "Internal server error" });
  });

  return app;
}
