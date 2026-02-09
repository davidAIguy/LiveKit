import { FastifyInstance } from "fastify";
import { z } from "zod";
import { appendCallEvent, findCallContext, getNextUtteranceStart, insertUtterance } from "../db.js";
import { env } from "../config.js";
import { generateAgentResponse, generateAiDecision, resolveAiMode } from "../services/ai.js";
import { executeToolCommand, fetchToolCatalog, parseToolCommand, ToolCommandSyntaxError } from "../services/automation.js";
import { voiceSessionManager } from "../services/voice/session-manager.js";
import { twilioMediaBridge } from "../services/voice/twilio-media-bridge.js";
import { AgentConnectorLaunchSchema, AgentUserTurnSchema } from "../types.js";

const activeSessions = new Map<
  string,
  {
    call_id: string;
    tenant_id: string;
    agent_id: string;
    trace_id: string;
    room: string;
    twilio_call_sid: string;
    livekit_url: string;
    connected_at: string;
  }
>();

function validateConnectorAuth(authorizationHeader: string | undefined): boolean {
  if (!env.CONNECTOR_AUTH_TOKEN) {
    return true;
  }
  if (!authorizationHeader) {
    return false;
  }

  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return false;
  }
  return token === env.CONNECTOR_AUTH_TOKEN;
}

function estimateDurationMs(text: string): number {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  return words * 380;
}

function defaultSystemPrompt(): string {
  return "Eres un agente de voz profesional. Responde en espanol claro y breve, confirma datos importantes y evita inventar informacion.";
}

function summarizeToolPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "sin contenido";
  }

  if (typeof payload === "string") {
    return payload.slice(0, 280);
  }

  const raw = JSON.stringify(payload);
  if (!raw) {
    return "sin contenido";
  }
  return raw.length > 280 ? `${raw.slice(0, 280)}...` : raw;
}

const turnQueues = new Map<string, Promise<void>>();

async function enqueueTurn<T>(callId: string, task: () => Promise<T>): Promise<T> {
  const previous = turnQueues.get(callId) ?? Promise.resolve();
  let result: T | undefined;
  let failure: unknown;

  const current = previous.then(async () => {
    try {
      result = await task();
    } catch (error) {
      failure = error;
    }
  });

  turnQueues.set(callId, current);
  await current;

  if (failure) {
    throw failure;
  }

  return result as T;
}

export async function registerRuntimeRoutes(app: FastifyInstance): Promise<void> {
  async function processCallerTurn(input: {
    callId: string;
    text: string;
    traceId: string;
    source: "api" | "stt";
    confidence?: number;
  }): Promise<{
    call_id: string;
    trace_id: string;
    mode: string;
    response_text: string;
    tool_execution?: Record<string, unknown>;
  }> {
    const session = activeSessions.get(input.callId);
    if (!session) {
      throw new Error("session_not_active");
    }

    const callContext = await findCallContext(input.callId);
    if (!callContext) {
      throw new Error("call_context_not_found");
    }

    const aiMode = resolveAiMode();

    const callerStart = await getNextUtteranceStart(input.callId);
    const callerDuration = estimateDurationMs(input.text);
    const callerEnd = callerStart + callerDuration;

    await insertUtterance({
      callId: input.callId,
      speaker: "caller",
      text: input.text,
      startMs: callerStart,
      endMs: callerEnd,
      confidence: input.confidence ?? 0.99
    });

    await appendCallEvent(input.callId, "runtime.connector_user_turn_received", {
      trace_id: input.traceId,
      text: input.text,
      source: input.source
    });

    let agentText: string;
    let toolExecutionMeta: Record<string, unknown> | undefined;

    let parsedToolCommand: ReturnType<typeof parseToolCommand>;
    try {
      parsedToolCommand = parseToolCommand(input.text);
    } catch (error) {
      if (error instanceof ToolCommandSyntaxError) {
        throw error;
      }
      throw error;
    }

    if (parsedToolCommand) {
      await appendCallEvent(input.callId, "runtime.connector_tool_requested", {
        trace_id: input.traceId,
        tool_name: parsedToolCommand.toolName,
        input_json: parsedToolCommand.inputJson,
        source: input.source
      });

      const toolExecution = await executeToolCommand({
        callId: input.callId,
        traceId: input.traceId,
        toolName: parsedToolCommand.toolName,
        inputJson: parsedToolCommand.inputJson
      });

      toolExecutionMeta = {
        tool_name: parsedToolCommand.toolName,
        status: toolExecution.status,
        execution_id: toolExecution.execution_id,
        error_code: toolExecution.error_code,
        response_json: toolExecution.response_json,
        source: input.source
      };

      if (toolExecution.ok) {
        agentText = `Listo. Ejecute la herramienta ${parsedToolCommand.toolName}. Resultado: ${summarizeToolPayload(toolExecution.response_json)}`;
      } else {
        agentText = `No pude ejecutar la herramienta ${parsedToolCommand.toolName}. Error: ${toolExecution.error_code ?? "tool_execution_failed"}.`;
      }
    } else {
      const canRunLlmToolCalls = env.AUTOMATION_LLM_TOOL_CALLS_ENABLED && aiMode === "openai";
      if (canRunLlmToolCalls) {
        const catalog = await fetchToolCatalog(input.callId);
        if (catalog.ok && catalog.items.length > 0) {
          const decision = await generateAiDecision({
            systemPrompt: callContext.system_prompt ?? defaultSystemPrompt(),
            userText: input.text,
            model: callContext.llm_model,
            availableTools: catalog.items.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchemaJson: tool.input_schema_json
            }))
          });

          if (decision.type === "tool_call") {
            const selectedTool = catalog.items.find((tool) => tool.name === decision.toolName);
            if (selectedTool) {
              await appendCallEvent(input.callId, "runtime.connector_tool_requested", {
                trace_id: input.traceId,
                tool_name: decision.toolName,
                input_json: decision.inputJson,
                source: "llm_auto"
              });

              const toolExecution = await executeToolCommand({
                callId: input.callId,
                traceId: input.traceId,
                toolName: decision.toolName,
                inputJson: decision.inputJson
              });

              toolExecutionMeta = {
                tool_name: decision.toolName,
                status: toolExecution.status,
                execution_id: toolExecution.execution_id,
                error_code: toolExecution.error_code,
                response_json: toolExecution.response_json,
                source: "llm_auto"
              };

              if (toolExecution.ok) {
                agentText =
                  decision.text?.trim() ||
                  `Listo. Ejecute la herramienta ${decision.toolName}. Resultado: ${summarizeToolPayload(toolExecution.response_json)}`;
              } else {
                agentText = `No pude ejecutar la herramienta ${decision.toolName}. Error: ${toolExecution.error_code ?? "tool_execution_failed"}.`;
              }
            } else {
              agentText =
                "No tengo disponible esa herramienta para esta sesion. Puedo continuar con una respuesta directa si quieres.";
            }
          } else {
            agentText = decision.text;
          }
        } else {
          agentText = await generateAgentResponse({
            systemPrompt: callContext.system_prompt ?? defaultSystemPrompt(),
            userText: input.text,
            model: callContext.llm_model
          });
        }
      } else {
        if (aiMode === "openai_unconfigured") {
          throw new Error("openai_unconfigured");
        }

        agentText = await generateAgentResponse({
          systemPrompt: callContext.system_prompt ?? defaultSystemPrompt(),
          userText: input.text,
          model: callContext.llm_model
        });
      }
    }

    const agentStart = callerEnd + 120;
    const agentDuration = estimateDurationMs(agentText);
    const agentEnd = agentStart + agentDuration;

    await insertUtterance({
      callId: input.callId,
      speaker: "agent",
      text: agentText,
      startMs: agentStart,
      endMs: agentEnd,
      confidence: 1
    });

    await appendCallEvent(input.callId, "runtime.connector_agent_turn_generated", {
      trace_id: input.traceId,
      model: callContext.llm_model,
      mode: aiMode,
      source: input.source,
      response_text: agentText,
      ...(toolExecutionMeta ? { tool_execution: toolExecutionMeta } : {})
    });

    try {
      const voiceSpeak = await voiceSessionManager.speak(input.callId, agentText);
      if (voiceSpeak.attempted) {
        await appendCallEvent(input.callId, "runtime.voice_tts_synthesized", {
          trace_id: input.traceId,
          bytes: voiceSpeak.bytes,
          transport_mode: voiceSpeak.transport_mode
        });

        if (voiceSpeak.packet) {
          const sentToTwilio = twilioMediaBridge.sendAgentAudio(input.callId, voiceSpeak.packet);
          if (sentToTwilio) {
            await appendCallEvent(input.callId, "runtime.twilio_media_stream_sent_tts", {
              trace_id: input.traceId,
              bytes: voiceSpeak.bytes
            });
          }
        }
      }
    } catch (error) {
      await appendCallEvent(input.callId, "runtime.voice_tts_failed", {
        trace_id: input.traceId,
        error: error instanceof Error ? error.message : "voice_tts_error"
      });
    }

    return {
      call_id: input.callId,
      trace_id: input.traceId,
      mode: aiMode,
      response_text: agentText,
      ...(toolExecutionMeta ? { tool_execution: toolExecutionMeta } : {})
    };
  }

  app.get("/runtime/ai-mode", async (request, reply) => {
    if (!validateConnectorAuth(request.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid connector auth" });
      return;
    }

    reply.send({ mode: resolveAiMode() });
  });

  app.post("/runtime/connect", async (request, reply) => {
    if (!validateConnectorAuth(request.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid connector auth" });
      return;
    }

    const payload = AgentConnectorLaunchSchema.parse(request.body);

    activeSessions.set(payload.call_id, {
      ...payload,
      connected_at: new Date().toISOString()
    });

    const callContext = await findCallContext(payload.call_id);
    if (!callContext) {
      reply.code(404).send({ error: "not_found", message: "Call context not found" });
      return;
    }

    let voiceResult:
      | {
          enabled: boolean;
          started: boolean;
          stt_provider: string;
          stt_mode: string;
          tts_provider: string;
          tts_mode: string;
          transport_mode: string;
        }
      | { enabled: boolean; started: false; error: string };

    try {
      voiceResult = await voiceSessionManager.start(
        {
          callId: payload.call_id,
          traceId: payload.trace_id,
          room: payload.room,
          livekitUrl: payload.livekit_url,
          agentJoinToken: payload.agent_join_token,
          sttProvider: callContext.stt_provider,
          ttsProvider: callContext.tts_provider
        },
        {
          onTranscript: async (event) => {
            await appendCallEvent(payload.call_id, "runtime.voice_stt_transcript", {
              trace_id: payload.trace_id,
              provider: event.provider,
              is_final: event.isFinal,
              confidence: event.confidence ?? null,
              text: event.text
            });

            if (!event.isFinal) {
              return;
            }

            await enqueueTurn(payload.call_id, async () => {
              try {
                await processCallerTurn({
                  callId: payload.call_id,
                  text: event.text,
                  traceId: payload.trace_id,
                  source: "stt",
                  confidence: event.confidence
                });
              } catch (error) {
                await appendCallEvent(payload.call_id, "runtime.voice_turn_failed", {
                  trace_id: payload.trace_id,
                  error: error instanceof Error ? error.message : "voice_turn_processing_error"
                });
              }
            });
          },
          onSttError: async (error) => {
            await appendCallEvent(payload.call_id, "runtime.voice_stt_failed", {
              trace_id: payload.trace_id,
              error: error.message
            });
          },
          onBargeIn: async (bargeIn) => {
            const cleared = twilioMediaBridge.clearPlayback(payload.call_id);
            await appendCallEvent(payload.call_id, "runtime.voice_barge_in_detected", {
              trace_id: payload.trace_id,
              reason: bargeIn.reason,
              energy: bargeIn.energy,
              twilio_clear_sent: cleared
            });
          }
        }
      );
    } catch (error) {
      voiceResult = {
        enabled: env.CONNECTOR_VOICE_RUNTIME_ENABLED,
        started: false,
        error: error instanceof Error ? error.message : "voice_session_start_failed"
      };
    }

    await appendCallEvent(payload.call_id, "runtime.connector_session_started", {
      trace_id: payload.trace_id,
      room: payload.room,
      livekit_url: payload.livekit_url,
      connector_mode: resolveAiMode(),
      voice_runtime: voiceResult
    });

    if ("error" in voiceResult) {
      await appendCallEvent(payload.call_id, "runtime.voice_session_failed", {
        trace_id: payload.trace_id,
        error: voiceResult.error
      });
    }

    app.log.info(
      {
        call_id: payload.call_id,
        tenant_id: payload.tenant_id,
        agent_id: payload.agent_id,
        trace_id: payload.trace_id,
        room: payload.room,
        livekit_url: payload.livekit_url,
        voice_runtime: voiceResult
      },
      "Connector session started"
    );

    reply.code(202).send({
      ok: true,
      accepted: true,
      mode: resolveAiMode(),
      voice_runtime: voiceResult
    });
  });

  app.post("/runtime/sessions/:callId/user-turn", async (request, reply) => {
    if (!validateConnectorAuth(request.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid connector auth" });
      return;
    }

    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const body = AgentUserTurnSchema.parse(request.body);

    const session = activeSessions.get(params.callId);
    if (!session) {
      reply.code(404).send({ error: "not_found", message: "Session not active for call" });
      return;
    }

    try {
      const result = await enqueueTurn(params.callId, () =>
        processCallerTurn({
          callId: params.callId,
          text: body.text,
          traceId: session.trace_id,
          source: "api"
        })
      );

      reply.send({
        ok: true,
        ...result
      });
    } catch (error) {
      if (error instanceof ToolCommandSyntaxError) {
        reply.code(400).send({ error: "bad_request", message: error.message });
        return;
      }

      if (error instanceof Error && error.message === "openai_unconfigured") {
        reply.code(503).send({
          error: "openai_unconfigured",
          message: "Set OPENAI_API_KEY or enable AGENT_CONNECTOR_MOCK_AI"
        });
        return;
      }

      throw error;
    }
  });

  app.get("/runtime/sessions", async (request, reply) => {
    if (!validateConnectorAuth(request.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid connector auth" });
      return;
    }

    reply.send({ items: Array.from(activeSessions.values()) });
  });

  app.get("/runtime/voice/sessions", async (request, reply) => {
    if (!validateConnectorAuth(request.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid connector auth" });
      return;
    }

    reply.send({
      enabled: env.CONNECTOR_VOICE_RUNTIME_ENABLED,
      items: voiceSessionManager.list()
    });
  });

  app.get("/runtime/voice/readiness", async (request, reply) => {
    if (!validateConnectorAuth(request.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid connector auth" });
      return;
    }

    const ttsRimeReady = Boolean(env.TTS_RIME_API_URL && env.TTS_RIME_API_KEY);
    const ttsRemiReady = Boolean(env.TTS_REMI_API_URL && env.TTS_REMI_API_KEY);

    reply.send({
      voice_runtime_enabled: env.CONNECTOR_VOICE_RUNTIME_ENABLED,
      livekit_transport_mode: env.CONNECTOR_LIVEKIT_TRANSPORT_MODE,
      stt: {
        deepgram_ready: Boolean(env.STT_DEEPGRAM_API_KEY),
        model: env.STT_DEEPGRAM_MODEL,
        language: env.STT_DEEPGRAM_LANGUAGE
      },
      tts: {
        rime_ready: ttsRimeReady,
        remi_ready: ttsRemiReady,
        timeout_ms: env.TTS_REQUEST_TIMEOUT_MS,
        retries: env.TTS_MAX_RETRIES
      },
      barge_in: {
        enabled: env.VOICE_BARGE_IN_ENABLED,
        energy_threshold: env.VOICE_BARGE_IN_ENERGY_THRESHOLD,
        hold_ms: env.VOICE_BARGE_IN_HOLD_MS
      },
      twilio: {
        media_stream_token_required: Boolean(env.TWILIO_MEDIA_STREAM_TOKEN)
      }
    });
  });

  app.post("/runtime/sessions/:callId/close", async (request, reply) => {
    if (!validateConnectorAuth(request.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid connector auth" });
      return;
    }

    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const session = activeSessions.get(params.callId);
    if (!session) {
      reply.code(404).send({ error: "not_found", message: "Session not active for call" });
      return;
    }

    activeSessions.delete(params.callId);
    turnQueues.delete(params.callId);
    twilioMediaBridge.unbindByCallId(params.callId);
    await voiceSessionManager.stop(params.callId);
    await appendCallEvent(params.callId, "runtime.connector_session_closed", {
      trace_id: session.trace_id
    });

    reply.send({ ok: true, call_id: params.callId });
  });
}
