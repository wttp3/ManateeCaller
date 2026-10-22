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
import { isForwarderRequestAllowed } from "./webhook/forwarder.js";
import { runWebhookOnce } from "./webhook/once.js";
import { decodeWebhookBody, PayloadTooLargeError, readCappedBody } from "./webhook/raw-body.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolvePublicDir(__dirname);

type InboundMessage = {
  id?: unknown;
  from?: unknown;
  type?: unknown;
  text?: { body?: string };
  audio?: { id?: string };
  button?: { payload?: string };
  interactive?: { button_reply?: { id?: string } };
};

function hubSignature(req: Request): string | undefined {
  const value = req.headers["x-hub-signature-256"];
  return typeof value === "string" ? value : undefined;
}

function forwarderHeader(req: Request, config: AppConfig): string | undefined {
  if (config.webhookForwarder.mode !== "header") {
    return undefined;
  }
  const value = req.get(config.webhookForwarder.name);
  return typeof value === "string" ? value : undefined;
}

async function acceptInboundMessages(
  payload: unknown,
  config: AppConfig,
  participants: ParticipantService,
  jobs: JobService,
  interview: InterviewService,
): Promise<void> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) {
    return;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) {
      continue;
    }
    for (const change of changes) {
      if (!change || typeof change !== "object") {
        continue;
      }
      const messages = (change as { value?: { messages?: unknown } }).value?.messages;
      if (!Array.isArray(messages)) {
        continue;
      }
      for (const message of messages) {
        if (!message || typeof message !== "object") {
          continue;
        }
        const inbound = message as InboundMessage;
        const messageId = inbound.id;
        if (typeof messageId !== "string" || messageId.length === 0) {
          continue;
        }
        const from = normalizePhone(typeof inbound.from === "string" ? inbound.from : "");
        if (!isPilotSenderAllowed(from, config.pilotAllowedSenders)) {
          logInfo(INBOUND_IGNORED_MESSAGE, { from: maskPhone(from) });
          continue;
        }

        const eventKey = `msg:${messageId}`;
        await runWebhookOnce(eventKey, async () => {
          const isNew = await jobs.recordWebhook(eventKey, message, participants.phoneLookupHash(from));
          if (!isNew) {
            return;
          }
          await interview.handleInboundMessage({
            from,
            type: typeof inbound.type === "string" ? inbound.type : "",
            text: inbound.text?.body,
            buttonReplyId: inbound.button?.payload ?? inbound.interactive?.button_reply?.id,
            mediaId: inbound.audio?.id,
            messageId,
          });
        });
      }
    }
  }
}

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
      // Forwarded webhooks may include X-Forwarded-For. The limit stays keyed
      // to the TCP peer; that header is not a configuration error.
      validate: { xForwardedForHeader: false },
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
    rateLimit({ windowMs: 60 * 60 * 1000, max: 20, validate: { xForwardedForHeader: false } }),
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
    rateLimit({ windowMs: 60 * 60 * 1000, max: 10, validate: { xForwardedForHeader: false } }),
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

  app.post("/webhook/whatsapp", async (req, res) => {
    let rawBody: Buffer;
    try {
      rawBody = await readCappedBody(req, config.whatsappWebhookMaxBytes);
    } catch (err) {
      if (res.headersSent) {
        return;
      }
      if (err instanceof PayloadTooLargeError) {
        res.sendStatus(413);
        return;
      }
      logError("Webhook body could not be read");
      res.sendStatus(400);
      return;
    }

    if (!isForwarderRequestAllowed(config.webhookForwarder, req.socket.remoteAddress, forwarderHeader(req, config))) {
      logInfo("Rejected webhook from an unexpected forwarder", { mode: config.webhookForwarder.mode });
      res.sendStatus(403);
      return;
    }

    const signature = hubSignature(req);
    let signatureOk = false;
    try {
      signatureOk = whatsapp.verifySignature(rawBody, signature);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) {
      res.sendStatus(403);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(decodeWebhookBody(rawBody, config.whatsappWebhookMaxBytes).toString("utf8"));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.sendStatus(413);
        return;
      }
      logError("Webhook body was not valid JSON");
      res.sendStatus(400);
      return;
    }

    res.sendStatus(200);

    try {
      await acceptInboundMessages(payload, config, participants, jobs, interview);
    } catch (err) {
      logError("Webhook processing failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  });

  app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      return;
    }
    const status = err.status ?? err.statusCode;
    if (status === 413 || err.type === "entity.too.large") {
      res.sendStatus(413);
      return;
    }
    logError("Unhandled error", { error: err.message });
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.sendStatus(status);
      return;
    }
    res.status(500).json({ ok: false, error: "Internal server error" });
  });

  return app;
}
