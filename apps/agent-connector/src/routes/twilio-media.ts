import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appendCallEvent, findCallByTwilioSid, findCallContext } from "../db.js";
import { env } from "../config.js";
import { voiceSessionManager } from "../services/voice/session-manager.js";
import { twilioMediaBridge } from "../services/voice/twilio-media-bridge.js";
import { decodeTwilioMediaPayload } from "../services/voice/twilio-audio.js";

const greetedCalls = new Set<string>();

const ConnectedEventSchema = z.object({
  event: z.literal("connected"),
  streamSid: z.string().optional()
});

const StartEventSchema = z.object({
  event: z.literal("start"),
  streamSid: z.string().min(1),
  start: z.object({
    callSid: z.string().min(1),
    customParameters: z.record(z.string(), z.string()).optional()
  })
});

const MediaEventSchema = z.object({
  event: z.literal("media"),
  streamSid: z.string().min(1),
  media: z.object({
    payload: z.string().min(1)
  })
});

const StopEventSchema = z.object({
  event: z.literal("stop"),
  streamSid: z.string().min(1)
});

const AnyEventSchema = z.union([ConnectedEventSchema, StartEventSchema, MediaEventSchema, StopEventSchema]);

function parseRawMessage(raw: unknown): unknown {
  if (typeof raw === "string") {
    return JSON.parse(raw);
  }
  if (raw instanceof Buffer) {
    return JSON.parse(raw.toString("utf8"));
  }
  if (raw instanceof Uint8Array) {
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  }
  return raw;
}

function resolveAuthToken(
  query: unknown,
  customParameters: Record<string, string> | undefined
): string | undefined {
  const queryToken =
    query && typeof query === "object" && "token" in query && typeof (query as { token?: unknown }).token === "string"
      ? ((query as { token: string }).token as string)
      : undefined;

  return customParameters?.token ?? queryToken;
}

export async function registerTwilioMediaRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/twilio/media-stream",
    {
      websocket: true
    },
    (socket, request) => {
      let callId: string | null = null;
      let traceId: string | null = null;
      let streamSid: string | null = null;
      let sawNoSession = false;
      let queue = Promise.resolve();

      const enqueue = (task: () => Promise<void>) => {
        queue = queue.then(task).catch((error) => {
          app.log.error({ error }, "twilio media websocket handler failed");
        });
      };

      socket.on("message", (raw: Buffer | string | Uint8Array) => {
        enqueue(async () => {
          let parsedRaw: unknown;
          try {
            parsedRaw = parseRawMessage(raw);
          } catch {
            return;
          }

          const parsed = AnyEventSchema.safeParse(parsedRaw);
          if (!parsed.success) {
            return;
          }

          const event = parsed.data;
          if (event.event === "connected") {
            return;
          }

          if (event.event === "start") {
            const authToken = resolveAuthToken(request.query, event.start.customParameters);
            if (env.TWILIO_MEDIA_STREAM_TOKEN && authToken !== env.TWILIO_MEDIA_STREAM_TOKEN) {
              socket.close();
              return;
            }

            const call = await findCallByTwilioSid(event.start.callSid);
            if (!call) {
              socket.close();
              return;
            }

            callId = call.call_id;
            traceId = call.trace_id;
            streamSid = event.streamSid;

            twilioMediaBridge.bind({
              callId,
              streamSid,
              socket
            });

            await appendCallEvent(callId, "runtime.twilio_media_stream_started", {
              trace_id: traceId,
              stream_sid: streamSid,
              call_sid: event.start.callSid
            });

            if (env.VOICE_AUTO_GREETING_ENABLED && !greetedCalls.has(callId)) {
              greetedCalls.add(callId);
              try {
                const callContext = await findCallContext(callId);
                const greetingText = callContext?.greeting_text?.trim() || env.VOICE_AUTO_GREETING_TEXT;
                const greetingSource = callContext?.greeting_text?.trim() ? "agent_config" : "connector_default";

                const speak = await voiceSessionManager.speak(callId, greetingText);
                if (speak.attempted) {
                  await appendCallEvent(callId, "runtime.voice_tts_synthesized", {
                    trace_id: traceId,
                    bytes: speak.bytes,
                    transport_mode: speak.transport_mode,
                    source: "auto_greeting",
                    greeting_source: greetingSource
                  });

                  if (speak.packet) {
                    const sent = twilioMediaBridge.sendAgentAudio(callId, speak.packet);
                    if (sent) {
                      await appendCallEvent(callId, "runtime.twilio_media_stream_sent_tts", {
                        trace_id: traceId,
                        bytes: speak.bytes,
                        source: "auto_greeting",
                        greeting_source: greetingSource
                      });
                    }
                  }

                  await appendCallEvent(callId, "runtime.voice_auto_greeting_sent", {
                    trace_id: traceId,
                    stream_sid: streamSid,
                    greeting_source: greetingSource,
                    greeting_text: greetingText
                  });
                }
              } catch (error) {
                await appendCallEvent(callId, "runtime.voice_tts_failed", {
                  trace_id: traceId,
                  source: "auto_greeting",
                  error: error instanceof Error ? error.message : "voice_auto_greeting_failed"
                });
              }
            }

            return;
          }

          if (event.event === "media") {
            if (!callId) {
              return;
            }

            try {
              const frame = decodeTwilioMediaPayload(event.media.payload);
              const ingest = await voiceSessionManager.ingestInboundAudio(callId, frame);
              if (!ingest.ingested && !sawNoSession) {
                sawNoSession = true;
                await appendCallEvent(callId, "runtime.twilio_media_stream_waiting_session", {
                  trace_id: traceId,
                  stream_sid: streamSid
                });
              }

            } catch (error) {
              await appendCallEvent(callId, "runtime.twilio_media_stream_error", {
                trace_id: traceId,
                stream_sid: streamSid,
                error: error instanceof Error ? error.message : "twilio_media_stream_error"
              });
            }
            return;
          }

          if (event.event === "stop") {
            if (callId) {
              await appendCallEvent(callId, "runtime.twilio_media_stream_stopped", {
                trace_id: traceId,
                stream_sid: event.streamSid
              });
              twilioMediaBridge.unbindByCallId(callId);
              greetedCalls.delete(callId);
            }
            socket.close();
          }
        });
      });

      socket.on("close", () => {
        if (callId) {
          void appendCallEvent(callId, "runtime.twilio_media_stream_disconnected", {
            trace_id: traceId,
            stream_sid: streamSid
          });
          greetedCalls.delete(callId);
        }
        twilioMediaBridge.unbindBySocket(socket);
      });
    }
  );
}
