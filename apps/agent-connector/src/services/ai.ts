import { env } from "../config.js";

interface GenerateResponseInput {
  systemPrompt: string;
  userText: string;
  model: string;
}

interface AvailableToolInput {
  name: string;
  description: string;
  inputSchemaJson: unknown;
}

interface GenerateDecisionInput extends GenerateResponseInput {
  availableTools: AvailableToolInput[];
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type AiDecision =
  | {
      type: "response";
      text: string;
    }
  | {
      type: "tool_call";
      toolName: string;
      inputJson: unknown;
      text?: string;
    };

function mockResponse(userText: string): string {
  return `Entendido. Procesando tu solicitud: "${userText}". En esta fase local te respondo en modo simulacion.`;
}

async function callOpenAi(messages: OpenAiMessage[], model: string, temperature = 0.3): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: model || env.OPENAI_MODEL_FALLBACK,
        temperature,
        messages
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`openai_error_${response.status}:${body}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("openai_empty_response");
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveAiMode(): "mock_ai" | "openai" | "openai_unconfigured" {
  if (env.AGENT_CONNECTOR_MOCK_AI) {
    return "mock_ai";
  }
  if (!env.OPENAI_API_KEY) {
    return "openai_unconfigured";
  }
  return "openai";
}

export async function generateAgentResponse(input: GenerateResponseInput): Promise<string> {
  if (env.AGENT_CONNECTOR_MOCK_AI) {
    return mockResponse(input.userText);
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error("openai_key_missing");
  }

  return callOpenAi(
    [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userText }
    ],
    input.model,
    0.3
  );
}

export async function generateAiDecision(input: GenerateDecisionInput): Promise<AiDecision> {
  if (env.AGENT_CONNECTOR_MOCK_AI || !env.OPENAI_API_KEY) {
    return {
      type: "response",
      text: mockResponse(input.userText)
    };
  }

  const toolCatalogText = JSON.stringify(
    input.availableTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema_json: tool.inputSchemaJson
    }))
  );

  const content = await callOpenAi(
    [
      {
        role: "system",
        content: `${input.systemPrompt}\n\nActua como orquestador de herramientas. Responde EXCLUSIVAMENTE JSON valido con uno de estos formatos: {"type":"response","text":"..."} o {"type":"tool_call","tool_name":"...","input_json":{...}}. Si decides tool_call, tool_name debe ser exactamente uno de los nombres del catalogo y input_json debe ser un objeto JSON. Si no hay una herramienta adecuada, usa type=response.`
      },
      {
        role: "user",
        content: `Usuario: ${input.userText}\n\nCatalogo de herramientas: ${toolCatalogText}`
      }
    ],
    input.model,
    0.1
  );

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.type === "tool_call" && typeof parsed.tool_name === "string") {
      return {
        type: "tool_call",
        toolName: parsed.tool_name,
        inputJson: parsed.input_json,
        text: typeof parsed.text === "string" ? parsed.text : undefined
      };
    }

    if (parsed.type === "response" && typeof parsed.text === "string") {
      return {
        type: "response",
        text: parsed.text
      };
    }
  } catch {
    return {
      type: "response",
      text: content
    };
  }

  return {
    type: "response",
    text: content
  };
}
