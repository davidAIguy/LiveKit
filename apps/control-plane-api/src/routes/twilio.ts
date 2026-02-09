import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db.js";
import { isValidTwilioSignature } from "../services/twilio.js";

const InboundWebhookSchema = z.object({
  CallSid: z.string().min(1),
  From: z.string().min(1),
  To: z.string().min(1)
});

function twimlResponse(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-MX">${message}</Say><Hangup/></Response>`;
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function twimlStreamResponse(input: { streamUrl: string; token?: string }): string {
  const streamUrl = escapeXml(input.streamUrl);
  const tokenParameter = input.token
    ? `<Parameter name="token" value="${escapeXml(input.token)}"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-MX">Conectando con tu asistente.</Say><Connect><Stream url="${streamUrl}">${tokenParameter}</Stream></Connect></Response>`;
}

function resolvePublicWebhookUrl(rawUrl: string | undefined): string | null {
  if (!env.TWILIO_WEBHOOK_BASE_URL || !rawUrl) {
    return null;
  }

  const base = env.TWILIO_WEBHOOK_BASE_URL.endsWith("/")
    ? env.TWILIO_WEBHOOK_BASE_URL.slice(0, -1)
    : env.TWILIO_WEBHOOK_BASE_URL;
  return `${base}${rawUrl}`;
}

export async function registerTwilioRoutes(app: FastifyInstance): Promise<void> {
  app.post("/twilio/webhook/inbound", async (request, reply) => {
    if (env.TWILIO_VALIDATE_SIGNATURE) {
      if (!env.TWILIO_AUTH_TOKEN) {
        reply.code(500).send({
          error: "misconfigured_server",
          message: "TWILIO_AUTH_TOKEN is required when signature validation is enabled"
        });
        return;
      }

      const signature = request.headers["x-twilio-signature"];
      const twilioSignature = Array.isArray(signature) ? signature[0] : signature;
      const webhookUrl = resolvePublicWebhookUrl(request.raw.url);

      if (!webhookUrl) {
        reply.code(500).send({
          error: "misconfigured_server",
          message: "TWILIO_WEBHOOK_BASE_URL is required when signature validation is enabled"
        });
        return;
      }

      const valid = isValidTwilioSignature({
        url: webhookUrl,
        payload: request.body,
        authToken: env.TWILIO_AUTH_TOKEN,
        twilioSignature
      });

      if (!valid) {
        reply.code(403).send({ error: "forbidden", message: "Invalid Twilio signature" });
        return;
      }
    }

    const payload = InboundWebhookSchema.parse(request.body);

    const phoneRes = await db.query(
      `select id, tenant_id, agent_id
       from phone_numbers
       where e164 = $1 and status = 'active'
       limit 1`,
      [payload.To]
    );

    if (phoneRes.rows.length === 0) {
      reply.header("Content-Type", "text/xml");
      reply.send(twimlResponse("Lo sentimos, este numero no esta configurado."));
      return;
    }

    const target = phoneRes.rows[0] as {
      id: string;
      tenant_id: string;
      agent_id: string;
    };
    const livekitRoom = `call-${payload.CallSid}`;
    const traceId = randomUUID();

    await db.query(
      `with upserted_call as (
         insert into calls (tenant_id, agent_id, phone_number_id, twilio_call_sid, livekit_room, started_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (twilio_call_sid)
         do update set livekit_room = excluded.livekit_room
         returning id, tenant_id, agent_id, twilio_call_sid, livekit_room
       )
       insert into call_events (call_id, type, payload_json)
       select
         c.id,
         'runtime.handoff_requested',
         $6::jsonb
       from upserted_call c`,
      [
        target.tenant_id,
        target.agent_id,
        target.id,
        payload.CallSid,
        livekitRoom,
        JSON.stringify({
          version: "v1",
          trace_id: traceId,
          source: "twilio_inbound_webhook",
          tenant_id: target.tenant_id,
          agent_id: target.agent_id,
          twilio_call_sid: payload.CallSid,
          room: livekitRoom,
          from: payload.From,
          to: payload.To
        })
      ]
    );

    app.log.info(
      {
        callSid: payload.CallSid,
        from: payload.From,
        to: payload.To,
        room: livekitRoom,
        traceId
      },
      "Inbound call accepted"
    );

    reply.header("Content-Type", "text/xml");
    if (env.TWILIO_MEDIA_STREAM_URL) {
      reply.send(
        twimlStreamResponse({
          streamUrl: env.TWILIO_MEDIA_STREAM_URL,
          token: env.TWILIO_MEDIA_STREAM_TOKEN
        })
      );
      return;
    }

    reply.send(twimlResponse("Gracias por llamar. Estamos conectando con tu asistente de inteligencia artificial."));
  });
}
