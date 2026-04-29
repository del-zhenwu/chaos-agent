import path from "path";
import {
  discoverSkills,
  openAgent,
  type AgentSandboxContext,
  type SkillMetadata,
} from "@open-agents/agent";
import { connectSandbox } from "@open-agents/sandbox";
import { convertToModelMessages, type UIMessage } from "ai";
import { getClusterConfigByName } from "@/lib/history-store";

export const maxDuration = 300;

type SelectionContext = {
  question: string;
  multiSelect: boolean;
  selectedOption: {
    label: string;
    value?: string;
    description?: string;
  };
  options: Array<{
    label: string;
    value?: string;
    description?: string;
  }>;
};

const CHAOS_SKILL_ALLOWLIST = new Set([
  "chaos-mesh-experiment-prepare",
  "chaos-mesh-experiment-execute",
  "chaosblade-experiment-prepare",
  "chaosblade-experiment-execute",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeSelectionContext(input: unknown): SelectionContext | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question) {
    return null;
  }
  const selected = asRecord(record.selectedOption);
  if (!selected) {
    return null;
  }
  const selectedLabel = typeof selected.label === "string" ? selected.label.trim() : "";
  if (!selectedLabel) {
    return null;
  }
  const selectedValue =
    typeof selected.value === "string" && selected.value.trim().length > 0
      ? selected.value.trim()
      : undefined;
  const selectedDescription =
    typeof selected.description === "string" && selected.description.trim().length > 0
      ? selected.description.trim()
      : undefined;

  const options = Array.isArray(record.options)
    ? record.options
        .map((item) => {
          const option = asRecord(item);
          if (!option) {
            return null;
          }
          const label = typeof option.label === "string" ? option.label.trim() : "";
          if (!label) {
            return null;
          }
          const value =
            typeof option.value === "string" && option.value.trim().length > 0
              ? option.value.trim()
              : undefined;
          const description =
            typeof option.description === "string" && option.description.trim().length > 0
              ? option.description.trim()
              : undefined;
          return {
            label,
            ...(value ? { value } : {}),
            ...(description ? { description } : {}),
          };
        })
        .filter(
          (
            item,
          ): item is { label: string; value?: string; description?: string } =>
            item !== null,
        )
    : [];

  return {
    question,
    multiSelect: record.multiSelect === true,
    selectedOption: {
      label: selectedLabel,
      ...(selectedValue ? { value: selectedValue } : {}),
      ...(selectedDescription ? { description: selectedDescription } : {}),
    },
    options,
  };
}

function buildSelectionContextMessage(context: SelectionContext): string {
  const optionLines = context.options.map((option, index) => {
    const details = [option.label];
    if (option.value) {
      details.push(`value=${option.value}`);
    }
    if (option.description) {
      details.push(`description=${option.description}`);
    }
    return `${index + 1}. ${details.join(" | ")}`;
  });
  return [
    "User selection context for this turn:",
    `question: ${context.question}`,
    `selected_label: ${context.selectedOption.label}`,
    context.selectedOption.value ? `selected_value: ${context.selectedOption.value}` : "",
    context.selectedOption.description
      ? `selected_description: ${context.selectedOption.description}`
      : "",
    optionLines.length > 0 ? `all_options:\n${optionLines.join("\n")}` : "",
    "Treat this as the user's explicit latest choice and continue workflow from this chosen option.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function normalizeIncomingMessages(messages: unknown): UIMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message, index) => {
      if (!message || typeof message !== "object") {
        return null;
      }

      const record = message as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : `msg-${index}`;
      const role = record.role;
      if (role !== "system" && role !== "user" && role !== "assistant") {
        return null;
      }

      if (Array.isArray(record.parts)) {
        return {
          id,
          role,
          parts: record.parts as UIMessage["parts"],
          metadata: record.metadata,
        };
      }

      const content = record.content;
      if (typeof content === "string") {
        return {
          id,
          role,
          parts: [{ type: "text", text: content }],
        };
      }

      return null;
    })
    .filter((message): message is UIMessage => message !== null);
}

function stripIncompleteToolParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }

    const filteredParts = message.parts.filter((part) => {
      if (!part || typeof part !== "object" || typeof part.type !== "string") {
        return true;
      }
      if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") {
        return true;
      }
      if ("state" in part && typeof part.state === "string") {
        return (
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied"
        );
      }
      return true;
    });

    return { ...message, parts: filteredParts };
  });
}

function resolveSkillDirectories(): string[] {
  const appDir = process.cwd();
  const openAgentsBaseDir = path.resolve(appDir, "..", "..");
  const workspaceRoot = path.resolve(openAgentsBaseDir, "..");
  return [
    path.join(workspaceRoot, "skills"),
    path.join(openAgentsBaseDir, ".agents", "skills"),
  ];
}

async function loadAvailableSkills(
  sandbox: Awaited<ReturnType<typeof connectSandbox>>,
): Promise<SkillMetadata[]> {
  try {
    const discoveredSkills = await discoverSkills(sandbox, resolveSkillDirectories());
    return discoveredSkills.filter((skill) => CHAOS_SKILL_ALLOWLIST.has(skill.name));
  } catch (error) {
    console.error("Failed to discover skills:", error);
    return [];
  }
}

export async function POST(req: Request) {
  const { messages, clusterName, chaosEngine, selectionContext } = (await req.json()) as {
    messages: unknown;
    clusterName?: unknown;
    chaosEngine?: unknown;
    selectionContext?: unknown;
  };
  const normalizedSelectionContext = normalizeSelectionContext(selectionContext);

  const normalizedClusterName = typeof clusterName === "string" ? clusterName.trim() : "";
  const normalizedChaosEngine =
    typeof chaosEngine === "string" ? chaosEngine.trim().toLowerCase() : "";
  if (
    normalizedChaosEngine === "chaos-mesh" ||
    normalizedChaosEngine === "chaosmesh" ||
    normalizedChaosEngine === "chaosblade-k8s" ||
    normalizedChaosEngine === "chaosblade"
  ) {
    process.env.CHAOS_ENGINE =
      normalizedChaosEngine === "chaosblade" ? "chaosblade-k8s" : normalizedChaosEngine;
  } else if (!process.env.CHAOS_ENGINE) {
    process.env.CHAOS_ENGINE = "chaos-mesh";
  }
  const activeChaosEngine = process.env.CHAOS_ENGINE ?? "chaos-mesh";
  let effectiveToken = "";
  let effectiveEndpoint = "";

  process.env.CHAOS_CLUSTER_NAME = normalizedClusterName;

  try {
    const clusterConfig = await getClusterConfigByName(normalizedClusterName);
    process.env.CHAOS_CLUSTER_NAME = clusterConfig.name;
    effectiveToken = clusterConfig.token ?? "";
    effectiveEndpoint = clusterConfig.endpoint;
  } catch (error) {
    console.error("Failed to load cluster token from database:", error);
  }

  if (effectiveEndpoint) {
    process.env.CHAOS_DASHBOARD_URL = effectiveEndpoint;
  }

  if (!effectiveToken) {
    delete process.env.CHAOS_TOKEN;
    return new Response(
      `No API token configured for cluster ${process.env.CHAOS_CLUSTER_NAME}. Please save the token in Chaos Agent 配置 first.`,
      { status: 400 },
    );
  }
  process.env.CHAOS_TOKEN = effectiveToken;

  const safeMessages = stripIncompleteToolParts(normalizeIncomingMessages(messages));
  const messagesWithSelectionContext = normalizedSelectionContext
    ? [
        ...safeMessages,
        {
          id: `selection-context-${Date.now()}`,
          role: "user" as const,
          parts: [
            {
              type: "text" as const,
              text: buildSelectionContextMessage(normalizedSelectionContext),
            },
          ],
        },
      ]
    : safeMessages;
  const modelMessages = await convertToModelMessages(
    messagesWithSelectionContext.map((message) => ({
      role: message.role,
      parts: message.parts,
      metadata: message.metadata,
    })),
    {
      ignoreIncompleteToolCalls: true,
    },
  );

  // Use the local sandbox
  const sandbox = await connectSandbox({
    state: { type: "local", workingDirectory: process.cwd() },
    options: { env: process.env as Record<string, string> }
  });
  const sandboxState = sandbox.getState?.() as AgentSandboxContext["state"] | undefined;
  if (!sandboxState) {
    return new Response("Sandbox state unavailable.", { status: 500 });
  }
  const skills = await loadAvailableSkills(sandbox);

  const result = await openAgent.stream({
    messages: modelMessages,
    options: {
      sandbox: {
        state: sandboxState,
        workingDirectory: sandbox.workingDirectory,
        environmentDetails:
          activeChaosEngine === "chaosblade-k8s"
            ? "Local Node.js Environment with ChaosBlade Kubernetes API access"
            : "Local Node.js Environment with Chaos Mesh Dashboard API access",
      },
      skills,
      model: "openai/gpt-4o",
      customInstructions: `You are a Chaos Agent that supports two engines: chaos-mesh and chaosblade-k8s.
Current default engine from environment: ${activeChaosEngine}.

Skill-first policy:
1. For prepare/generate/update chaos experiment requests:
   - If the user explicitly requests ChaosBlade (or chaosblade-k8s), your FIRST tool call must be \`skill\` with \`skill: "chaosblade-experiment-prepare"\`.
   - Otherwise, your FIRST tool call must be \`skill\` with \`skill: "chaos-mesh-experiment-prepare"\`.
2. For execute/run/start existing chaos experiment requests:
   - If the experiment is ChaosBlade (or user requests ChaosBlade), your FIRST tool call must be \`skill\` with \`skill: "chaosblade-experiment-execute"\`.
   - Otherwise, your FIRST tool call must be \`skill\` with \`skill: "chaos-mesh-experiment-execute"\`.
3. Never use local \`kubectl\` commands for execution. Execution must go through chaos APIs/tools with cluster token.
4. Keep behavior scenario-agnostic. Do not hardcode pod-only assumptions or scenario-specific routing logic in this API layer.
5. Never fabricate or mock namespaces/pods/labels/YAML/status. Use only real tool outputs.
6. Use \`ask_user_question\` when user intent is ambiguous or multiple valid targets exist.
7. For clarification, prefer multiple-choice options over free-text prompts. Give concrete candidate options whenever possible.
8. For resource selection questions, options must use exact full identifiers from tool outputs (namespace + kind + full name when available). Do not shorten identifiers.
9. For ambiguous target choices, include all discovered resource candidates plus one "Other/其它（手动输入）" option; do not use "cancel" as the default fallback option.
10. For resource-choice questions, set \`options[].value\` to canonical identifiers (e.g., \`namespace/kind/name\`) so user choices remain unambiguous.
11. Do not use regex/sub-string heuristics as the final target decision. Let model reasoning + real tool evidence decide.
12. Ensure final confirmation card content is based on verified targets only. If target verification fails, do not ask for execution confirmation.
13. If any tool returns \`success: false\`, explain the failure and provide next concrete recovery actions.
14. During multi-step tool workflows, provide short natural-language progress updates (what you are checking, what you found, what is next), not tool calls only.
14a. Immediately after a user makes a choice/confirmation, send one short progress sentence before running long tool chains (for example: "正在校验目标并生成下一步确认...").
15. For execution updates, include experiment status and elapsed time in user-facing summary.
16. When using \`ask_user_question\` for experiment confirmation, keep question text concise and do NOT inline raw YAML in the question body.
17. For ChaosBlade flows, pass \`engine: "chaosblade-k8s"\` in chaos tool arguments.
18. For Chaos Mesh flows, pass \`engine: "chaos-mesh"\` in chaos tool arguments.
19. Keep a single confirmation gate before execution: if the user already confirmed in prepare flow, do not ask a second confirmation in execute flow.
20. Never return an empty response.`,
    },
  });

  const streamResult = result as {
    toDataStreamResponse?: () => Response;
    toUIMessageStreamResponse?: () => Response;
    toTextStreamResponse?: () => Response;
  };

  // Prefer AI SDK data stream protocol for useChat compatibility (SSE-based).
  if (typeof streamResult.toDataStreamResponse === "function") {
    return streamResult.toDataStreamResponse();
  }
  // Fallback to UIMessage stream when data stream is unavailable.
  if (typeof streamResult.toUIMessageStreamResponse === "function") {
    return streamResult.toUIMessageStreamResponse();
  }
  if (typeof streamResult.toTextStreamResponse === "function") {
    return streamResult.toTextStreamResponse();
  }

  return new Response("Unsupported stream response type.", { status: 500 });
}
