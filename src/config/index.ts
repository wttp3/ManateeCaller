import { z } from "zod";
import { parsePilotAllowlist } from "../pilot/allowlist.js";
import { parseWebhookForwarder } from "../webhook/forwarder.js";

export const DEFAULT_WHATSAPP_WEBHOOK_MAX_BYTES = 256 * 1024;

const hexKey = z
  .string()
  .length(64, "must be 64 hex characters (32 bytes)")
  .regex(/^[0-9a-fA-F]+$/, "must be hex");

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  publicBaseUrl: z.string().url(),
  databaseUrl: z.string().min(1),
  whatsappPhoneNumberId: z.string().min(1),
  whatsappBusinessAccountId: z.string().min(1),
  whatsappAccessToken: z.string().min(1),
  whatsappAppSecret: z.string().min(1),
  whatsappWebhookVerifyToken: z.string().min(1),
  whatsappTemplateName: z.string().min(1),
  whatsappTemplateInvitesEnabled: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === "") {
        return false;
      }
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
        return false;
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be true or false" });
      return z.NEVER;
    }),
  whatsappApiVersion: z.string().default("v22.0"),
  optInKeyword: z
    .string()
    .optional()
    .transform((value) => {
      const keyword = value?.trim() ?? "";
      return keyword.length > 0 ? keyword : "I'm in";
    }),
  pilotAllowedSenders: z
    .string()
    .optional()
    .default("")
    .transform((raw, ctx) => {
      try {
        return parsePilotAllowlist(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must be comma-separated E.164 numbers",
        });
        return z.NEVER;
      }
    }),
  erasureKeyword: z
    .string()
    .optional()
    .transform((value) => {
      const keyword = value?.trim() ?? "";
      return keyword.length > 0 ? keyword : "DELETE MY DATA";
    }),
  erasureAdminToken: z
    .string()
    .optional()
    .transform((value) => {
      const token = value?.trim() ?? "";
      return token.length > 0 ? token : null;
    }),
  elevenLabsApiKey: z.string().min(1),
  elevenLabsEnableZeroRetention: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  dataEncryptionKey: hexKey,
  tileHmacKey: hexKey,
  lookupHmacKey: hexKey,
  sessionTimeoutHours: z.coerce.number().int().positive().default(24),
  maxVoiceNoteBytes: z.coerce.number().int().positive().default(16_777_216),
  maxVoiceNoteSeconds: z.coerce.number().int().positive().default(120),
  tempAudioDir: z.string().default("./tmp/audio"),
  jobPollIntervalMs: z.coerce.number().int().positive().default(2000),
  whatsappWebhookMaxBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .default(DEFAULT_WHATSAPP_WEBHOOK_MAX_BYTES),
  webhookForwarder: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return parseWebhookForwarder(value);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : "invalid forwarder",
        });
        return z.NEVER;
      }
    }),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse({
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    whatsappBusinessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN,
    whatsappAppSecret: env.WHATSAPP_APP_SECRET,
    whatsappWebhookVerifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    whatsappTemplateName: env.WHATSAPP_TEMPLATE_NAME,
    whatsappTemplateInvitesEnabled: env.WHATSAPP_TEMPLATE_INVITES_ENABLED,
    whatsappApiVersion: env.WHATSAPP_API_VERSION,
    optInKeyword: env.OPT_IN_KEYWORD,
    pilotAllowedSenders: env.PILOT_ALLOWED_SENDERS,
    erasureKeyword: env.ERASURE_KEYWORD,
    erasureAdminToken: env.ERASURE_ADMIN_TOKEN,
    elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    elevenLabsEnableZeroRetention: env.ELEVENLABS_ENABLE_ZERO_RETENTION,
    dataEncryptionKey: env.DATA_ENCRYPTION_KEY,
    tileHmacKey: env.TILE_HMAC_KEY,
    lookupHmacKey: env.LOOKUP_HMAC_KEY,
    sessionTimeoutHours: env.SESSION_TIMEOUT_HOURS,
    maxVoiceNoteBytes: env.MAX_VOICE_NOTE_BYTES,
    maxVoiceNoteSeconds: env.MAX_VOICE_NOTE_SECONDS,
    tempAudioDir: env.TEMP_AUDIO_DIR,
    jobPollIntervalMs: env.JOB_POLL_INTERVAL_MS,
    whatsappWebhookMaxBytes: env.WHATSAPP_WEBHOOK_MAX_BYTES,
    webhookForwarder: env.WHATSAPP_WEBHOOK_FORWARDER,
  });

  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }

  return parsed.data;
}

/** Returns config for display — never includes secret values. */
export function redactConfig(config: AppConfig): Record<string, string | number | boolean> {
  return {
    port: config.port,
    nodeEnv: config.nodeEnv,
    publicBaseUrl: config.publicBaseUrl,
    databaseUrl: "[redacted]",
    whatsappPhoneNumberId: config.whatsappPhoneNumberId,
    whatsappTemplateName: config.whatsappTemplateName,
    whatsappTemplateInvitesEnabled: config.whatsappTemplateInvitesEnabled,
    whatsappApiVersion: config.whatsappApiVersion,
    optInKeyword: config.optInKeyword,
    pilotAllowedSenderCount: config.pilotAllowedSenders.length,
    erasureKeyword: config.erasureKeyword,
    erasureAdminConfigured: config.erasureAdminToken !== null,
    elevenLabsEnableZeroRetention: config.elevenLabsEnableZeroRetention,
    sessionTimeoutHours: config.sessionTimeoutHours,
    maxVoiceNoteBytes: config.maxVoiceNoteBytes,
    maxVoiceNoteSeconds: config.maxVoiceNoteSeconds,
    whatsappWebhookMaxBytes: config.whatsappWebhookMaxBytes,
    webhookForwarder: config.webhookForwarder.mode,
    secretsConfigured: true,
  };
}
