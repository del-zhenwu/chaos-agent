import { generateText, tool } from "ai";
import { z } from "zod";
import * as path from "path";
import { getSandbox, toDisplayPath } from "./utils";
import { gateway } from "../models";
import * as yaml from "yaml";

type NormalizedPod = {
  name: string;
  namespace?: string;
  state?: string;
  labels?: Record<string, string>;
};

type ChaosPodsQuery = {
  namespaces: string[];
  labelSelectors: Record<string, string>;
};

type ExperimentIdentity = {
  apiVersion?: string;
  kind?: string;
  name?: string;
  namespace?: string;
};

const chaosEngineSchema = z.enum(["chaos-mesh", "chaosblade-k8s"]);
type ChaosEngine = z.infer<typeof chaosEngineSchema>;

function resolveChaosEngine(engineInput?: unknown): ChaosEngine {
  const normalized =
    typeof engineInput === "string" ? engineInput.trim().toLowerCase() : "";
  if (normalized === "chaosblade-k8s" || normalized === "chaosblade") {
    return "chaosblade-k8s";
  }
  if (normalized === "chaos-mesh" || normalized === "chaosmesh") {
    return "chaos-mesh";
  }
  const fromEnv = process.env.CHAOS_ENGINE?.trim().toLowerCase();
  if (fromEnv === "chaosblade-k8s" || fromEnv === "chaosblade") {
    return "chaosblade-k8s";
  }
  return "chaos-mesh";
}

function uniquePodsByIdentity(pods: NormalizedPod[]): NormalizedPod[] {
  const seen = new Set<string>();
  const uniquePods: NormalizedPod[] = [];

  for (const pod of pods) {
    const key = `${pod.namespace ?? ""}/${pod.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniquePods.push(pod);
  }

  return uniquePods;
}

const semanticPodSelectionSchema = z.object({
  pickedIds: z.array(z.number().int().positive()).max(60),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  rationale: z.string().optional(),
});

function extractJsonObjectText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const firstLineBreak = trimmed.indexOf("\n");
  if (firstLineBreak < 0) {
    return trimmed;
  }
  const lastFenceIndex = trimmed.lastIndexOf("```");
  if (lastFenceIndex <= firstLineBreak) {
    return trimmed;
  }
  return trimmed.slice(firstLineBreak + 1, lastFenceIndex).trim();
}

function getChaosApiInfo(engineInput?: unknown) {
  const clusterName = process.env.CHAOS_CLUSTER_NAME;
  const token = process.env.CHAOS_TOKEN;
  const engine = resolveChaosEngine(engineInput);
  const baseUrl = process.env.CHAOS_DASHBOARD_URL?.trim() || "";
  const kubernetesApiUrl =
    process.env.KUBERNETES_API_URL || process.env.CHAOSBLADE_K8S_API_URL || "";
  return { clusterName, token, baseUrl, kubernetesApiUrl, engine };
}

function parseJsonText(text: string): { success: true; value: unknown } | { success: false; error: string } {
  try {
    return { success: true, value: text ? JSON.parse(text) : null };
  } catch {
    return {
      success: false,
      error: `Failed to parse JSON: ${text.slice(0, 100)}`,
    };
  }
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractExperimentIdentity(resource: unknown): ExperimentIdentity {
  const root = asObjectRecord(resource);
  if (!root) {
    return {};
  }
  const metadata = asObjectRecord(root.metadata);
  const apiVersion = typeof root.apiVersion === "string" ? root.apiVersion : undefined;
  const kind = typeof root.kind === "string" ? root.kind : undefined;
  const name = typeof metadata?.name === "string" ? metadata.name : undefined;
  const namespace = typeof metadata?.namespace === "string" ? metadata.namespace : undefined;
  return { apiVersion, kind, name, namespace };
}

function parseDurationToMs(duration: string): number | undefined {
  const normalized = duration.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  let multiplier = 1000;
  let valueText = normalized;

  if (normalized.endsWith("ms")) {
    multiplier = 1;
    valueText = normalized.slice(0, -2);
  } else if (normalized.endsWith("s")) {
    multiplier = 1000;
    valueText = normalized.slice(0, -1);
  } else if (normalized.endsWith("m")) {
    multiplier = 60 * 1000;
    valueText = normalized.slice(0, -1);
  } else if (normalized.endsWith("h")) {
    multiplier = 60 * 60 * 1000;
    valueText = normalized.slice(0, -1);
  } else if (normalized.endsWith("d")) {
    multiplier = 24 * 60 * 60 * 1000;
    valueText = normalized.slice(0, -1);
  }

  const numeric = Number(valueText);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.floor(numeric * multiplier);
}

function shouldContinueMonitoringUntilConfiguredDuration(
  monitorStartMs: number,
  configuredDurationMs: number | undefined,
): boolean {
  if (typeof configuredDurationMs !== "number" || configuredDurationMs <= 0) {
    return false;
  }
  return Date.now() - monitorStartMs < configuredDurationMs;
}

function parsePossibleTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 10_000_000_000) {
      return Math.floor(value);
    }
    if (value > 1_000_000_000) {
      return Math.floor(value * 1000);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    if (asNumber > 10_000_000_000) {
      return Math.floor(asNumber);
    }
    if (asNumber > 1_000_000_000) {
      return Math.floor(asNumber * 1000);
    }
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return parsed;
}

function getDurationMsFromResource(resource: Record<string, unknown>): number | undefined {
  const spec = asObjectRecord(resource.spec);
  if (!spec) {
    return undefined;
  }
  const duration = spec.duration;
  if (typeof duration !== "string") {
    return undefined;
  }
  return parseDurationToMs(duration);
}

function getExperimentStatus(summary: unknown): string | undefined {
  const summaryRecord = asObjectRecord(summary);
  if (!summaryRecord) {
    return undefined;
  }
  const rawStatus = summaryRecord.status ?? summaryRecord.Status;
  if (typeof rawStatus !== "string") {
    return undefined;
  }
  const status = rawStatus.trim();
  return status.length > 0 ? status : undefined;
}

function getExperimentCreatedAtMs(summary: unknown): number | undefined {
  const summaryRecord = asObjectRecord(summary);
  if (!summaryRecord) {
    return undefined;
  }
  const metadata = asObjectRecord(summaryRecord.metadata);
  const candidateValues = [
    summaryRecord.created,
    summaryRecord.Created,
    summaryRecord.creationTimestamp,
    summaryRecord.CreationTimestamp,
    summaryRecord.createdAt,
    summaryRecord.CreatedAt,
    summaryRecord.startTime,
    summaryRecord.StartTime,
    metadata?.creationTimestamp,
    metadata?.createdAt,
  ];
  for (const candidate of candidateValues) {
    const timestampMs = parsePossibleTimestampMs(candidate);
    if (timestampMs) {
      return timestampMs;
    }
  }
  return undefined;
}

function isExecutionInProgressStatus(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  return (
    normalized === "injecting" ||
    normalized === "running" ||
    normalized === "pending" ||
    normalized === "creating"
  );
}

function isExecutionFailedStatus(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  return normalized === "failed" || normalized === "error" || normalized === "errored";
}

function formatElapsedSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return seconds > 0
      ? `${hours}h ${minutes}m ${seconds}s`
      : `${hours}h ${minutes}m`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new Error("Aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      reject(new Error("Aborted"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function fetchExperimentSummary(
  baseUrl: string,
  token: string,
  identity: ExperimentIdentity,
  signal?: AbortSignal,
): Promise<{ success: true; summary: unknown } | { success: false; error: string }> {
  if (!identity.namespace || !identity.name || !identity.kind) {
    return { success: false, error: "Experiment identity is incomplete for status query." };
  }

  const query = new URLSearchParams({
    namespace: identity.namespace,
    name: identity.name,
    kind: identity.kind,
  });

  try {
    const listResponse = await fetch(`${baseUrl}/api/experiments?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!listResponse.ok) {
      const listText = await listResponse.text();
      return {
        success: false,
        error: `Status query failed: ${listResponse.status} ${listText.slice(0, 300)}`,
      };
    }

    const listText = await listResponse.text();
    const parsedList = parseJsonText(listText);
    if (!parsedList.success) {
      return { success: false, error: parsedList.error };
    }
    if (!Array.isArray(parsedList.value) || parsedList.value.length === 0) {
      return {
        success: false,
        error: `Experiment not found yet: ${identity.namespace}/${identity.name} (${identity.kind})`,
      };
    }

    return { success: true, summary: parsedList.value[0] };
  } catch (error: any) {
    return {
      success: false,
      error: `Status query exception: ${error?.message ?? String(error)}`,
    };
  }
}

function normalizePods(data: unknown): NormalizedPod[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((pod) => {
      if (!pod || typeof pod !== "object") {
        return null;
      }
      const record = pod as Record<string, unknown>;
      const name = record.name ?? record.Name;
      const namespace = record.namespace ?? record.Namespace;
      const state = record.state ?? record.State;
      const labelsRecord = asObjectRecord(record.labels ?? record.Labels);
      const labels = labelsRecord
        ? Object.fromEntries(
            Object.entries(labelsRecord).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
      return {
        name: typeof name === "string" ? name : "",
        namespace: typeof namespace === "string" ? namespace : undefined,
        state: typeof state === "string" ? state : undefined,
        labels,
      };
    })
    .filter((pod) => pod && pod.name.length > 0) as NormalizedPod[];
}

function formatLabelSelectors(labelSelectors: Record<string, string>): string {
  const entries = Object.entries(labelSelectors);
  if (entries.length === 0) {
    return "-";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

async function fetchPodsFromChaosApi(
  token: string,
  baseUrl: string,
  query: ChaosPodsQuery,
): Promise<{ success: true; pods: NormalizedPod[] } | { success: false; error: string }> {
  try {
    const response = await fetch(`${baseUrl}/api/common/pods`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(query),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Chaos Mesh API returned status ${response.status}: ${errorText}`,
      };
    }

    const text = await response.text();
    if (text.trim().length === 0) {
      return {
        success: false,
        error:
          "Chaos Mesh API /api/common/pods returned an empty response body. This indicates an upstream dashboard/API issue, not a confirmed 'no pods found' result.",
      };
    }
    const parsed = parseJsonText(text);
    if (!parsed.success) {
      return { success: false, error: parsed.error };
    }

    return { success: true, pods: normalizePods(parsed.value) };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to fetch pods from Chaos Mesh API: ${error.message}`,
    };
  }
}

function toKubernetesApiBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function buildKubernetesLabelSelector(labelSelectors: Record<string, string>): string {
  const entries = Object.entries(labelSelectors);
  if (entries.length === 0) {
    return "";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

async function fetchKubernetesApiJson(
  kubernetesApiUrl: string,
  token: string,
  pathWithQuery: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ success: true; value: unknown } | { success: false; error: string }> {
  try {
    const response = await fetch(`${toKubernetesApiBaseUrl(kubernetesApiUrl)}${pathWithQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      return {
        success: false,
        error: `Kubernetes API returned status ${response.status}: ${responseText.slice(0, 400)}`,
      };
    }
    const parsed = parseJsonText(responseText);
    if (!parsed.success) {
      return { success: false, error: parsed.error };
    }
    return { success: true, value: parsed.value };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to call Kubernetes API: ${error?.message ?? String(error)}`,
    };
  }
}

async function fetchNamespacesFromChaosMeshApi(
  token: string,
  baseUrl: string,
): Promise<{ success: true; namespaces: string[] } | { success: false; error: string }> {
  try {
    const response = await fetch(`${baseUrl}/api/common/chaos-available-namespaces`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return {
        success: false,
        error: `Failed to list namespaces from Chaos Mesh API: status ${response.status}`,
      };
    }
    const text = await response.text();
    const parsed = parseJsonText(text);
    if (!parsed.success) {
      return { success: false, error: parsed.error };
    }
    const namespaces = Array.isArray(parsed.value)
      ? parsed.value.filter((item): item is string => typeof item === "string")
      : [];
    return { success: true, namespaces };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to list namespaces from Chaos Mesh API: ${error?.message ?? String(error)}`,
    };
  }
}

async function fetchNamespacesFromKubernetesApi(
  token: string,
  kubernetesApiUrl: string,
): Promise<{ success: true; namespaces: string[] } | { success: false; error: string }> {
  if (!kubernetesApiUrl) {
    return {
      success: false,
      error:
        "KUBERNETES_API_URL is required for chaosblade-k8s engine. Example: https://kubernetes.default.svc",
    };
  }

  const result = await fetchKubernetesApiJson(kubernetesApiUrl, token, "/api/v1/namespaces");
  if (!result.success) {
    return result;
  }
  const root = asObjectRecord(result.value);
  const items = Array.isArray(root?.items) ? root.items : [];
  const namespaces = items
    .map((item) => {
      const metadata = asObjectRecord(asObjectRecord(item)?.metadata);
      const name = metadata?.name;
      return typeof name === "string" ? name : "";
    })
    .filter((name) => name.length > 0);
  return { success: true, namespaces };
}

async function fetchPodsFromKubernetesApi(
  token: string,
  kubernetesApiUrl: string,
  query: ChaosPodsQuery,
): Promise<{ success: true; pods: NormalizedPod[] } | { success: false; error: string }> {
  if (!kubernetesApiUrl) {
    return {
      success: false,
      error:
        "KUBERNETES_API_URL is required for chaosblade-k8s engine. Example: https://kubernetes.default.svc",
    };
  }

  const allPods: NormalizedPod[] = [];
  const labelSelector = buildKubernetesLabelSelector(query.labelSelectors);

  for (const namespace of query.namespaces) {
    const searchParams = new URLSearchParams();
    if (labelSelector) {
      searchParams.set("labelSelector", labelSelector);
    }
    const pathWithQuery = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods${
      searchParams.toString() ? `?${searchParams.toString()}` : ""
    }`;

    const result = await fetchKubernetesApiJson(kubernetesApiUrl, token, pathWithQuery);
    if (!result.success) {
      return result;
    }
    const root = asObjectRecord(result.value);
    const items = Array.isArray(root?.items) ? root.items : [];
    for (const item of items) {
      const itemRecord = asObjectRecord(item);
      if (!itemRecord) {
        continue;
      }
      const metadata = asObjectRecord(itemRecord.metadata);
      const status = asObjectRecord(itemRecord.status);
      const name = typeof metadata?.name === "string" ? metadata.name : "";
      if (!name) {
        continue;
      }
      const podNamespace =
        typeof metadata?.namespace === "string" ? metadata.namespace : namespace;
      const podState = typeof status?.phase === "string" ? status.phase : undefined;
      const labels = asObjectRecord(metadata?.labels)
        ? Object.fromEntries(
            Object.entries(asObjectRecord(metadata?.labels) ?? {}).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
      allPods.push({
        name,
        namespace: podNamespace,
        state: podState,
        labels,
      });
    }
  }

  return { success: true, pods: allPods };
}

async function fetchNamespacesForEngine(
  engine: ChaosEngine,
  token: string,
  baseUrl: string,
  kubernetesApiUrl: string,
): Promise<{ success: true; namespaces: string[] } | { success: false; error: string }> {
  if (engine === "chaosblade-k8s") {
    return fetchNamespacesFromKubernetesApi(token, kubernetesApiUrl);
  }
  if (!baseUrl) {
    return {
      success: false,
      error:
        "CHAOS_DASHBOARD_URL is required for chaos-mesh engine. Please set cluster endpoint in Chaos 对象集群配置.",
    };
  }
  return fetchNamespacesFromChaosMeshApi(token, baseUrl);
}

async function fetchPodsForEngine(
  engine: ChaosEngine,
  token: string,
  baseUrl: string,
  kubernetesApiUrl: string,
  query: ChaosPodsQuery,
): Promise<{ success: true; pods: NormalizedPod[] } | { success: false; error: string }> {
  if (engine === "chaosblade-k8s") {
    return fetchPodsFromKubernetesApi(token, kubernetesApiUrl, query);
  }
  if (!baseUrl) {
    return {
      success: false,
      error:
        "CHAOS_DASHBOARD_URL is required for chaos-mesh engine. Please set cluster endpoint in Chaos 对象集群配置.",
    };
  }
  return fetchPodsFromChaosApi(token, baseUrl, query);
}

function aggregateLabelValuesFromPods(pods: NormalizedPod[]): Record<string, string[]> {
  const labelMap = new Map<string, Set<string>>();
  for (const pod of pods) {
    const labels = pod.labels;
    if (!labels) {
      continue;
    }
    for (const [key, value] of Object.entries(labels)) {
      if (typeof value !== "string") {
        continue;
      }
      if (!labelMap.has(key)) {
        labelMap.set(key, new Set<string>());
      }
      labelMap.get(key)?.add(value);
    }
  }
  const result: Record<string, string[]> = {};
  for (const [key, values] of labelMap.entries()) {
    result[key] = Array.from(values).sort();
  }
  return result;
}

function buildSemanticPodChunks(pods: NormalizedPod[]): NormalizedPod[][] {
  if (pods.length === 0) {
    return [];
  }
  const maxModelCalls = 10;
  const minChunkSize = 220;
  const chunkSize = Math.max(minChunkSize, Math.ceil(pods.length / maxModelCalls));
  const chunks: NormalizedPod[][] = [];

  for (let start = 0; start < pods.length; start += chunkSize) {
    chunks.push(pods.slice(start, start + chunkSize));
  }

  return chunks;
}

async function findSemanticPodCandidates(keyword: string, pods: NormalizedPod[]): Promise<{
  matchedPods: NormalizedPod[];
  confidence?: "high" | "medium" | "low";
  rationale?: string;
  warning?: string;
}> {
  if (pods.length === 0) {
    return { matchedPods: [] };
  }
  const confidenceRank: Record<"low" | "medium" | "high", number> = {
    low: 1,
    medium: 2,
    high: 3,
  };
  const podChunks = buildSemanticPodChunks(pods);
  const matchedPodMap = new Map<string, NormalizedPod>();
  const warnings: string[] = [];
  let bestConfidence: "high" | "medium" | "low" | undefined;
  let bestRationale = "";

  for (let chunkIndex = 0; chunkIndex < podChunks.length; chunkIndex += 1) {
    const chunkPods = podChunks[chunkIndex] ?? [];
    if (chunkPods.length === 0) {
      continue;
    }
    const podList = chunkPods
      .map(
        (pod, index) =>
          `${index + 1}. ${pod.name}${pod.namespace ? ` (namespace: ${pod.namespace})` : ""}`,
      )
      .join("\n");

    try {
      const { text } = await generateText({
        model: gateway("openai/gpt-4o"),
        temperature: 0,
        prompt: `You are helping match a fuzzy user pod keyword to real Kubernetes pod names.
Keyword: "${keyword}"
Chunk: ${chunkIndex + 1} / ${podChunks.length}

Select pod IDs with HIGH RECALL: include every plausible intended candidate from THIS chunk, not only one best guess.
Rules:
- Prefer semantic/name similarity.
- Return multiple IDs when ambiguous or when there are variant names.
- If names differ by extra words (for example mobile/website/api) but still plausibly match the keyword, include all plausible variants.
- If none look plausible in this chunk, return empty pickedIds.
- Do not invent IDs outside this list.
- Output strict JSON only. No markdown, no extra text.

Required JSON schema:
{
  "pickedIds": number[],
  "confidence": "high" | "medium" | "low",
  "rationale": string
}

Pods in current chunk:
${podList}`,
      });
      const parsedText = extractJsonObjectText(text);
      const parsedObject = parseJsonText(parsedText);
      if (!parsedObject.success) {
        warnings.push(`chunk-${chunkIndex + 1}: non-JSON output`);
        continue;
      }
      const validated = semanticPodSelectionSchema.safeParse(parsedObject.value);
      if (!validated.success) {
        warnings.push(`chunk-${chunkIndex + 1}: invalid JSON shape`);
        continue;
      }
      const semanticOutput = validated.data;
      if (semanticOutput.confidence) {
        if (
          !bestConfidence ||
          confidenceRank[semanticOutput.confidence] > confidenceRank[bestConfidence]
        ) {
          bestConfidence = semanticOutput.confidence;
        }
      }
      if (!bestRationale && semanticOutput.rationale) {
        bestRationale = semanticOutput.rationale;
      }

      const selectedIndexes = new Set<number>();
      for (const rawId of semanticOutput.pickedIds) {
        const id = Math.trunc(rawId);
        if (id < 1 || id > chunkPods.length || selectedIndexes.has(id)) {
          continue;
        }
        const selectedPod = chunkPods[id - 1];
        if (!selectedPod) {
          continue;
        }
        selectedIndexes.add(id);
        const podKey = `${selectedPod.namespace ?? ""}/${selectedPod.name}`;
        if (!matchedPodMap.has(podKey)) {
          matchedPodMap.set(podKey, selectedPod);
        }
      }
    } catch (error: any) {
      warnings.push(`chunk-${chunkIndex + 1}: ${error?.message ?? String(error)}`);
    }
  }

  const mergedMatches = Array.from(matchedPodMap.values());
  let refinedMatches = mergedMatches;

  if (mergedMatches.length > 1) {
    const candidateList = mergedMatches
      .map(
        (pod, index) =>
          `${index + 1}. ${pod.name}${pod.namespace ? ` (namespace: ${pod.namespace})` : ""}`,
      )
      .join("\n");
    try {
      const { text } = await generateText({
        model: gateway("openai/gpt-4o"),
        temperature: 0,
        prompt: `You are validating pod candidates for a fuzzy keyword.
Keyword: "${keyword}"

From the candidate list, keep only pods that are truly relevant to the keyword semantics.
Rules:
- Keep all genuinely plausible variants for the same target family.
- Remove generic false positives that only share broad terms.
- If exactly one target is clear, return one ID.
- If multiple are plausible, return all plausible IDs.
- If none are plausible, return empty pickedIds.
- Output strict JSON only.

Required JSON schema:
{
  "pickedIds": number[],
  "confidence": "high" | "medium" | "low",
  "rationale": string
}

Candidates:
${candidateList}`,
      });
      const parsedText = extractJsonObjectText(text);
      const parsedObject = parseJsonText(parsedText);
      if (!parsedObject.success) {
        warnings.push("refine: non-JSON output");
      } else {
        const validated = semanticPodSelectionSchema.safeParse(parsedObject.value);
        if (!validated.success) {
          warnings.push("refine: invalid JSON shape");
        } else {
          const refinedOutput = validated.data;
          if (refinedOutput.confidence) {
            if (
              !bestConfidence ||
              confidenceRank[refinedOutput.confidence] > confidenceRank[bestConfidence]
            ) {
              bestConfidence = refinedOutput.confidence;
            }
          }
          if (refinedOutput.rationale) {
            bestRationale = refinedOutput.rationale;
          }
          const selectedIndexes = new Set<number>();
          const selectedPods: NormalizedPod[] = [];
          for (const rawId of refinedOutput.pickedIds) {
            const id = Math.trunc(rawId);
            if (id < 1 || id > mergedMatches.length || selectedIndexes.has(id)) {
              continue;
            }
            const selectedPod = mergedMatches[id - 1];
            if (!selectedPod) {
              continue;
            }
            selectedIndexes.add(id);
            selectedPods.push(selectedPod);
          }
          if (selectedPods.length > 0) {
            refinedMatches = selectedPods;
          }
        }
      }
    } catch (error: any) {
      warnings.push(`refine: ${error?.message ?? String(error)}`);
    }
  }

  return {
    matchedPods: refinedMatches,
    confidence: bestConfidence,
    rationale: bestRationale || undefined,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}

export const chaosGetNamespacesTool = tool({
  description: `Get all available namespaces from the selected chaos engine platform.`,
  inputSchema: z.object({
    engine: chaosEngineSchema.optional().describe("Chaos engine to query: chaos-mesh or chaosblade-k8s."),
  }),
  execute: async ({ engine }) => {
    const { token, baseUrl, kubernetesApiUrl, engine: resolvedEngine } = getChaosApiInfo(engine);
    if (!token) return { success: false, error: "No API token configured." };
    const result = await fetchNamespacesForEngine(resolvedEngine, token, baseUrl, kubernetesApiUrl);
    if (!result.success) {
      return result;
    }
    return { success: true, engine: resolvedEngine, namespaces: result.namespaces };
  },
});

export const chaosGetLabelsTool = tool({
  description: `Get labels for pods in specific namespaces from the selected chaos engine platform.`,
  inputSchema: z.object({
    namespaces: z.array(z.string()).describe("List of namespaces to query labels from"),
    engine: chaosEngineSchema.optional().describe("Chaos engine to query: chaos-mesh or chaosblade-k8s."),
  }),
  execute: async ({ namespaces, engine }) => {
    const { token, baseUrl, kubernetesApiUrl, engine: resolvedEngine } = getChaosApiInfo(engine);
    if (!token) return { success: false, error: "No API token configured." };

    if (resolvedEngine === "chaosblade-k8s") {
      const podsResult = await fetchPodsFromKubernetesApi(token, kubernetesApiUrl, {
        namespaces,
        labelSelectors: {},
      });
      if (!podsResult.success) {
        return podsResult;
      }
      return {
        success: true,
        engine: resolvedEngine,
        labels: aggregateLabelValuesFromPods(podsResult.pods),
      };
    }
    if (!baseUrl) {
      return {
        success: false,
        error:
          "CHAOS_DASHBOARD_URL is required for chaos-mesh engine. Please set cluster endpoint in Chaos 对象集群配置.",
      };
    }

    try {
      const nsParam = namespaces.join(",");
      const response = await fetch(`${baseUrl}/api/common/labels?podNamespaceList=${nsParam}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`Status ${response.status}`);
      }
      const text = await response.text();
      const parsed = parseJsonText(text);
      if (!parsed.success) {
        return { success: false, error: parsed.error };
      }
      const data = parsed.value ?? {};
      return { success: true, engine: resolvedEngine, labels: data };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
});

const chaosAPIEndpointSchema = z.object({
  namespace: z.string().describe("The namespace to query pods from"),
  labelSelectors: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Structured label selectors to filter pods, e.g. {\"app\":\"ai45-website-fe\"}",
    ),
  engine: chaosEngineSchema.optional().describe("Chaos engine to query: chaos-mesh or chaosblade-k8s."),
});

export const chaosGetPodsTool = tool({
  description: `Get real pod names from the selected chaos engine platform using the currently selected cluster.
Use this tool instead of 'kubectl get pods' to find pod names when the user gives you a partial name or label.`,
  inputSchema: chaosAPIEndpointSchema,
  execute: async ({ namespace, labelSelectors, engine }) => {
    const { clusterName, token, baseUrl, kubernetesApiUrl, engine: resolvedEngine } =
      getChaosApiInfo(engine);

    if (!token) {
      return {
        success: false,
        error: `No API token configured for cluster ${clusterName}. Please configure the token in the UI.`,
      };
    }

    const normalizedSelectors = labelSelectors ?? {};
    console.log(
      `Querying chaos engine ${resolvedEngine} for cluster ${clusterName}, namespace ${namespace}, labels ${JSON.stringify(normalizedSelectors)}`,
    );
    const podResult = await fetchPodsForEngine(resolvedEngine, token, baseUrl, kubernetesApiUrl, {
      namespaces: [namespace],
      labelSelectors: normalizedSelectors,
    });

    if (!podResult.success) {
      return {
        success: false,
        error: podResult.error,
      };
    }

    const podNames = podResult.pods.map((pod) => pod.name);

    return {
      success: true,
      engine: resolvedEngine,
      pods: podNames,
      labelSelectors: normalizedSelectors,
      message: `Found ${podNames.length} pods matching the label selector in namespace ${namespace}.`,
    };
  },
});

const findPodsInputSchema = z.object({
  keyword: z.string().min(1).describe("Fuzzy pod name keyword, e.g. ai45-fe"),
  namespaces: z.array(z.string()).optional().describe("Optional namespace scope. If omitted, search all namespaces."),
  engine: chaosEngineSchema.optional().describe("Chaos engine to query: chaos-mesh or chaosblade-k8s."),
});

export const chaosFindPodsTool = tool({
  description: `Find pods by partial pod name across namespaces using the selected chaos engine API.
Use this first when user gives a fuzzy name and exact namespace/label are unknown.`,
  inputSchema: findPodsInputSchema,
  execute: async ({ keyword, namespaces, engine }) => {
    const { clusterName, token, baseUrl, kubernetesApiUrl, engine: resolvedEngine } =
      getChaosApiInfo(engine);
    if (!token) {
      return {
        success: false,
        error: `No API token configured for cluster ${clusterName}. Please configure the token in the UI.`,
      };
    }

    try {
      let targetNamespaces = namespaces?.filter((namespace) => namespace.trim().length > 0) ?? [];

      if (targetNamespaces.length === 0) {
        const namespacesResult = await fetchNamespacesForEngine(
          resolvedEngine,
          token,
          baseUrl,
          kubernetesApiUrl,
        );
        if (!namespacesResult.success) {
          return namespacesResult;
        }
        targetNamespaces = namespacesResult.namespaces;
      }

      if (targetNamespaces.length === 0) {
        return { success: false, error: "No namespaces available for pod search." };
      }

      const podResult = await fetchPodsForEngine(
        resolvedEngine,
        token,
        baseUrl,
        kubernetesApiUrl,
        {
        namespaces: targetNamespaces,
        labelSelectors: {},
        },
      );
      if (!podResult.success) {
        return {
          success: false,
          error: podResult.error,
        };
      }

      const normalizedPods = podResult.pods;
      const semanticResult = await findSemanticPodCandidates(keyword, normalizedPods);
      const matchedPods = uniquePodsByIdentity(semanticResult.matchedPods);

      return {
        success: true,
        engine: resolvedEngine,
        keyword,
        matchStrategy: "llm-semantic",
        matchedCount: matchedPods.length,
        semanticMatchCount: semanticResult.matchedPods.length,
        podNames: matchedPods.map((pod) => pod.name),
        matchedPods: matchedPods.slice(0, 50),
        warning: matchedPods.length === 0 ? semanticResult.warning : undefined,
        message:
          matchedPods.length > 0
            ? `Found ${matchedPods.length} candidate pods for keyword "${keyword}".`
            : `No pods matched keyword "${keyword}" across ${targetNamespaces.length} namespaces.`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to search pods from ${resolvedEngine}: ${error.message}`,
      };
    }
  },
});

type ChaosBladeMatcher = {
  name: string;
  value: string[];
};

type PrepareExperimentInput = {
  scenario:
    | "pod-kill"
    | "pod-failure"
    | "network-delay"
    | "network-loss"
    | "cpu-stress"
    | "memory-stress";
  namespace: string;
  duration: string;
  labelSelectors: Record<string, string>;
  podNames: string[];
  additionalConfig: Record<string, unknown>;
};

function createExperimentResourceName(scenario: string): string {
  const suffix = Date.now().toString(36).slice(-6);
  return `${scenario}-experiment-${suffix}`;
}

function normalizeLatencyToMsText(rawLatency: string | undefined): string {
  if (!rawLatency) {
    return "100";
  }
  const trimmed = rawLatency.trim().toLowerCase();
  if (trimmed.endsWith("ms")) {
    const numeric = Number(trimmed.slice(0, -2));
    if (Number.isFinite(numeric) && numeric > 0) {
      return String(Math.floor(numeric));
    }
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return String(Math.floor(numeric));
  }
  return "100";
}

function normalizeLossPercentText(rawLoss: string | undefined): string {
  if (!rawLoss) {
    return "100";
  }
  const trimmed = rawLoss.trim().replace("%", "");
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    return "100";
  }
  const clamped = Math.min(100, Math.max(0, Math.floor(numeric)));
  return String(clamped);
}

function buildBaseChaosBladeMatchers(input: PrepareExperimentInput): ChaosBladeMatcher[] {
  const matchers: ChaosBladeMatcher[] = [];
  if (input.podNames.length > 0) {
    matchers.push({ name: "names", value: input.podNames });
  }
  if (Object.keys(input.labelSelectors).length > 0) {
    matchers.push({
      name: "labels",
      value: Object.entries(input.labelSelectors).map(([key, value]) => `${key}=${value}`),
    });
  }
  matchers.push({ name: "namespace", value: [input.namespace] });
  matchers.push({ name: "timeout", value: [input.duration] });
  return matchers;
}

function buildChaosBladeResource(input: PrepareExperimentInput): {
  success: true;
  resource: Record<string, unknown>;
  kind: string;
  metadataNamespace?: string;
} | {
  success: false;
  error: string;
} {
  const name = createExperimentResourceName(input.scenario);
  const matchers = buildBaseChaosBladeMatchers(input);
  let target = "pod";
  let action = "delete";
  let description = "delete pod";

  if (input.scenario === "pod-kill") {
    target = "pod";
    action = "delete";
    description = "delete pod";
  } else if (input.scenario === "pod-failure") {
    target = "pod";
    action = "fail";
    description = "inject pod failure";
  } else if (input.scenario === "network-delay") {
    target = "network";
    action = "delay";
    description = "delay pod network";
    matchers.push({
      name: "time",
      value: [normalizeLatencyToMsText(String(input.additionalConfig.latency ?? "100ms"))],
    });
    matchers.push({
      name: "interface",
      value: [String(input.additionalConfig.interface ?? "eth0")],
    });
  } else if (input.scenario === "network-loss") {
    target = "network";
    action = "loss";
    description = "loss pod network";
    matchers.push({
      name: "percent",
      value: [normalizeLossPercentText(String(input.additionalConfig.loss ?? "100"))],
    });
    matchers.push({
      name: "interface",
      value: [String(input.additionalConfig.interface ?? "eth0")],
    });
  } else if (input.scenario === "cpu-stress") {
    target = "cpu";
    action = "fullload";
    description = "increase pod cpu load";
    matchers.push({
      name: "cpu-percent",
      value: [String(input.additionalConfig.cpuPercent ?? "80")],
    });
  } else if (input.scenario === "memory-stress") {
    target = "mem";
    action = "load";
    description = "increase pod memory load";
    matchers.push({
      name: "mode",
      value: [String(input.additionalConfig.mode ?? "ram")],
    });
    matchers.push({
      name: "mem-percent",
      value: [String(input.additionalConfig.memPercent ?? "80")],
    });
  } else {
    return {
      success: false,
      error: `Unsupported scenario for chaosblade-k8s engine: ${input.scenario}`,
    };
  }

  return {
    success: true,
    resource: {
      apiVersion: "chaosblade.io/v1alpha1",
      kind: "ChaosBlade",
      metadata: {
        name,
      },
      spec: {
        experiments: [
          {
            scope: "pod",
            target,
            action,
            desc: description,
            matchers,
          },
        ],
      },
    },
    kind: "ChaosBlade",
  };
}

function getChaosBladeStatus(resource: unknown): string | undefined {
  const record = asObjectRecord(resource);
  const statusRecord = asObjectRecord(record?.status);
  const phase = statusRecord?.phase;
  if (typeof phase === "string" && phase.trim().length > 0) {
    return phase.trim();
  }
  const expStatuses = Array.isArray(statusRecord?.expStatuses) ? statusRecord.expStatuses : [];
  for (const expStatus of expStatuses) {
    const item = asObjectRecord(expStatus);
    const state = item?.state;
    if (typeof state === "string" && state.trim().length > 0) {
      return state.trim();
    }
  }
  return undefined;
}

function getChaosBladeCreatedAtMs(resource: unknown): number | undefined {
  const record = asObjectRecord(resource);
  if (!record) {
    return undefined;
  }
  const metadata = asObjectRecord(record?.metadata);
  const candidateValues = [
    metadata?.creationTimestamp,
    metadata?.createdAt,
    record.creationTimestamp,
    record.createdAt,
  ];
  for (const candidate of candidateValues) {
    const timestampMs = parsePossibleTimestampMs(candidate);
    if (timestampMs) {
      return timestampMs;
    }
  }
  return undefined;
}

function isChaosBladeFailedStatus(status: string | undefined, resource?: unknown): boolean {
  const normalized = status?.trim().toLowerCase();
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "errored" ||
    normalized === "exception"
  ) {
    return true;
  }
  const statusRecord = asObjectRecord(asObjectRecord(resource)?.status);
  const expStatuses = Array.isArray(statusRecord?.expStatuses) ? statusRecord.expStatuses : [];
  for (const expStatus of expStatuses) {
    const item = asObjectRecord(expStatus);
    if (item?.success === false) {
      return true;
    }
    const state = item?.state;
    if (typeof state === "string") {
      const lowered = state.toLowerCase();
      if (lowered.includes("fail") || lowered.includes("error")) {
        return true;
      }
    }
  }
  return false;
}

function isChaosBladeInProgressStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return (
    normalized === "running" ||
    normalized === "injecting" ||
    normalized === "pending" ||
    normalized === "creating" ||
    normalized === "created"
  );
}

const prepareInputSchema = z.object({
  scenario: z.enum(["pod-kill", "pod-failure", "network-delay", "network-loss", "cpu-stress", "memory-stress"]),
  namespace: z.string().describe("Target Kubernetes namespace"),
  labelSelectors: z
    .record(z.string(), z.string())
    .optional()
    .describe("Structured target pod labels, e.g. {\"app\":\"nginx\"}"),
  podNames: z.array(z.string()).optional().describe("Target specific pod names (use this if exact pod names are known)"),
  duration: z.string().default("10m").describe("Experiment duration (e.g., 10m, 30s)"),
  additionalConfig: z.record(z.string(), z.unknown()).optional().describe("Additional configuration"),
  engine: chaosEngineSchema.optional().describe("Chaos engine to use: chaos-mesh or chaosblade-k8s."),
});

export const chaosPrepareTool = tool({
  description: `Prepare a chaos experiment configuration for chaos-mesh or chaosblade-k8s.
Creates a directory with chaos-experiment.yaml and README.md.`,
  inputSchema: prepareInputSchema,
  execute: async (
    { scenario, namespace, labelSelectors, podNames, duration, additionalConfig, engine },
    { experimental_context },
  ) => {
    const sandbox = await getSandbox(experimental_context, "chaosPrepare");
    const workingDirectory = sandbox.workingDirectory;
    const { clusterName, token, baseUrl, kubernetesApiUrl, engine: resolvedEngine } =
      getChaosApiInfo(engine);

    if (!token) {
      return {
        success: false,
        error: `No API token configured for cluster ${clusterName}. Please configure the token in the UI.`,
      };
    }

    const normalizedPodNames = (podNames ?? [])
      .map((podName) => podName.trim())
      .filter((podName) => podName.length > 0);
    const parsedLabelSelectors = labelSelectors ?? {};
    const hasLabelSelector = Object.keys(parsedLabelSelectors).length > 0;
    if (!hasLabelSelector && normalizedPodNames.length === 0) {
      return {
        success: false,
        error: `No target selector was provided for namespace ${namespace}. Please provide podNames or labelSelectors.`,
      };
    }

    let verifiedPods: NormalizedPod[] = [];
    if (normalizedPodNames.length > 0) {
      const verifyPodResult = await fetchPodsForEngine(
        resolvedEngine,
        token,
        baseUrl,
        kubernetesApiUrl,
        {
        namespaces: [namespace],
        labelSelectors: {},
        },
      );
      if (!verifyPodResult.success) {
        return {
          success: false,
          error: `Failed to verify pods before preparing experiment: ${verifyPodResult.error}`,
        };
      }

      const podByName = new Map(verifyPodResult.pods.map((pod) => [pod.name, pod]));
      const missingPodNames = normalizedPodNames.filter((podName) => !podByName.has(podName));
      if (missingPodNames.length > 0) {
        return {
          success: false,
          error: `Pod verification failed in namespace ${namespace}. Missing pod names: ${missingPodNames.join(", ")}.`,
          missingPodNames,
          namespace,
          availablePodNames: verifyPodResult.pods.slice(0, 50).map((pod) => pod.name),
        };
      }

      verifiedPods = normalizedPodNames
        .map((podName) => podByName.get(podName))
        .filter((pod): pod is NormalizedPod => Boolean(pod));
    } else if (hasLabelSelector) {
      const verifyLabelResult = await fetchPodsForEngine(
        resolvedEngine,
        token,
        baseUrl,
        kubernetesApiUrl,
        {
          namespaces: [namespace],
          labelSelectors: parsedLabelSelectors,
        },
      );
      if (!verifyLabelResult.success) {
        return {
          success: false,
          error: `Failed to verify label selector before preparing experiment: ${verifyLabelResult.error}`,
        };
      }
      if (verifyLabelResult.pods.length === 0) {
        return {
          success: false,
          error: `No pods found with selector "${formatLabelSelectors(parsedLabelSelectors)}" in namespace ${namespace}.`,
          namespace,
          labelSelectors: parsedLabelSelectors,
        };
      }
      verifiedPods = verifyLabelResult.pods;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputDir = path.resolve(workingDirectory, `${timestamp}-${scenario}`);

    await sandbox.mkdir(outputDir, { recursive: true });

    const normalizedAdditionalConfig = additionalConfig ?? {};
    let resourceObject: Record<string, unknown>;
    let experimentKind = "PodChaos";
    let metadataNamespace = namespace;

    if (resolvedEngine === "chaosblade-k8s") {
      const bladeResourceResult = buildChaosBladeResource({
        scenario,
        namespace,
        duration,
        labelSelectors: parsedLabelSelectors,
        podNames: normalizedPodNames,
        additionalConfig: normalizedAdditionalConfig,
      });
      if (!bladeResourceResult.success) {
        return {
          success: false,
          error: bladeResourceResult.error,
        };
      }
      resourceObject = bladeResourceResult.resource;
      experimentKind = bladeResourceResult.kind;
      metadataNamespace = bladeResourceResult.metadataNamespace ?? "";
    } else {
      let kind = "PodChaos";
      const spec: Record<string, unknown> = {
        mode: "one",
        duration,
        selector: {
          namespaces: [namespace],
        },
      };

      if (hasLabelSelector) {
        const selector = asObjectRecord(spec.selector) ?? {};
        selector.labelSelectors = parsedLabelSelectors;
        spec.selector = selector;
      }
      if (normalizedPodNames.length > 0) {
        const selector = asObjectRecord(spec.selector) ?? {};
        selector.pods = {
          [namespace]: normalizedPodNames,
        };
        spec.selector = selector;
      }

      if (scenario === "pod-kill") {
        spec.action = "pod-kill";
      } else if (scenario === "pod-failure") {
        spec.action = "pod-failure";
      } else if (scenario === "network-delay") {
        kind = "NetworkChaos";
        spec.action = "delay";
        spec.delay = {
          latency: String(normalizedAdditionalConfig.latency ?? "10ms"),
          correlation: "100",
          jitter: "0ms",
        };
      } else if (scenario === "network-loss") {
        kind = "NetworkChaos";
        spec.action = "loss";
        spec.loss = {
          loss: String(normalizedAdditionalConfig.loss ?? "100"),
          correlation: "100",
        };
      } else if (scenario === "cpu-stress") {
        kind = "StressChaos";
        spec.mode = "one";
        spec.stressors = { cpu: { workers: 1, load: Number(normalizedAdditionalConfig.load ?? 100) } };
      } else if (scenario === "memory-stress") {
        kind = "StressChaos";
        spec.mode = "one";
        spec.stressors = { memory: { workers: 1, size: String(normalizedAdditionalConfig.size ?? "256MB") } };
      }

      experimentKind = kind;
      resourceObject = {
        apiVersion: "chaos-mesh.org/v1alpha1",
        kind,
        metadata: {
          name: createExperimentResourceName(scenario),
          namespace,
        },
        spec,
      };
    };
    const yamlContent = yaml.stringify(resourceObject);

    const readme = `# Chaos Experiment: ${scenario}
**Engine:** ${resolvedEngine}
**Namespace:** ${metadataNamespace || namespace}
**Labels:** ${formatLabelSelectors(parsedLabelSelectors)}
**Duration:** ${duration}

## Steps to Execute
Run the ${resolvedEngine === "chaosblade-k8s" ? "chaosblade-experiment-execute" : "chaos-mesh-experiment-execute"} skill to start this experiment.
`;

    await sandbox.writeFile(path.join(outputDir, "chaos-experiment.yaml"), yamlContent, "utf-8");
    await sandbox.writeFile(path.join(outputDir, "README.md"), readme, "utf-8");

    return {
      success: true,
      engine: resolvedEngine,
      directory: toDisplayPath(outputDir, workingDirectory),
      scenario,
      namespace: metadataNamespace || namespace,
      duration,
      labelSelectors: parsedLabelSelectors,
      podNames: normalizedPodNames,
      verifiedPods: verifiedPods.slice(0, 50),
      kind: experimentKind,
      yamlContent,
      message: `Prepared ${resolvedEngine} experiment in ${toDisplayPath(outputDir, workingDirectory)}. Targets were verified against namespace ${namespace}. You MUST show the generated YAML content to the user and ask for their confirmation before proceeding.`,
    };
  },
});

const executeInputSchema = z.object({
  directory: z.string().describe("Path to the prepared experiment directory"),
  engine: chaosEngineSchema.optional().describe("Chaos engine to use: chaos-mesh or chaosblade-k8s."),
});

export const chaosExecuteTool = tool({
  description: `Execute a prepared chaos experiment via the selected chaos engine API.`,
  inputSchema: executeInputSchema,
  execute: async ({ directory, engine }, { experimental_context, abortSignal }) => {
    const sandbox = await getSandbox(experimental_context, "chaosExecute");
    const workingDirectory = sandbox.workingDirectory;
    const { clusterName, token, baseUrl, kubernetesApiUrl, engine: configuredEngine } =
      getChaosApiInfo(engine);

    if (!token) {
      return {
        success: false,
        error: `No API token configured for cluster ${clusterName}. Please configure the token in the UI.`,
      };
    }

    const yamlPath = path.resolve(workingDirectory, directory, "chaos-experiment.yaml");
    try {
      await sandbox.access(yamlPath);
    } catch {
      return { success: false, error: `chaos-experiment.yaml not found in ${directory}` };
    }

    try {
      const yamlContent = await sandbox.readFile(yamlPath, "utf-8");
      const parsedResource = yaml.parse(yamlContent);
      const resourceObject = asObjectRecord(parsedResource);
      if (!resourceObject) {
        return {
          success: false,
          error: "chaos-experiment.yaml is not a valid object document.",
        };
      }
      const identity = extractExperimentIdentity(resourceObject);
      if (!identity.kind || !identity.apiVersion) {
        return {
          success: false,
          error: "chaos-experiment.yaml must include apiVersion and kind.",
        };
      }

      const inferredEngine =
        identity.apiVersion.startsWith("chaosblade.io/") || identity.kind === "ChaosBlade"
          ? "chaosblade-k8s"
          : configuredEngine;

      if (inferredEngine === "chaosblade-k8s") {
        if (!identity.name) {
          return {
            success: false,
            error: "ChaosBlade resource metadata.name is required.",
          };
        }
        if (!kubernetesApiUrl) {
          return {
            success: false,
            error:
              "KUBERNETES_API_URL is required for chaosblade-k8s execution. Example: https://kubernetes.default.svc",
          };
        }

        const createResult = await fetchKubernetesApiJson(
          kubernetesApiUrl,
          token,
          "/apis/chaosblade.io/v1alpha1/chaosblades",
          "POST",
          resourceObject,
          abortSignal,
        );
        if (!createResult.success) {
          return {
            success: false,
            error: `Failed to execute experiment via ChaosBlade API: ${createResult.error}`,
          };
        }
        const createBody = createResult.value;
        const createdAtFromCreateBodyMs = getChaosBladeCreatedAtMs(createBody);

        const timeoutFromMatchersMs = (() => {
          const spec = asObjectRecord(resourceObject.spec);
          const experiments = Array.isArray(spec?.experiments) ? spec.experiments : [];
          const firstExperiment = asObjectRecord(experiments[0]);
          const matchers = Array.isArray(firstExperiment?.matchers) ? firstExperiment.matchers : [];
          for (const matcher of matchers) {
            const matcherRecord = asObjectRecord(matcher);
            if (matcherRecord?.name !== "timeout") {
              continue;
            }
            const values = Array.isArray(matcherRecord.value) ? matcherRecord.value : [];
            const timeoutValue = typeof values[0] === "string" ? values[0] : "";
            const timeoutMs = parseDurationToMs(timeoutValue);
            if (timeoutMs) {
              return timeoutMs;
            }
          }
          return undefined;
        })();

        let experimentSummary: unknown = undefined;
        let latestStatus: string | undefined;
        let latestElapsedSeconds = 0;
        let terminalStateReached = false;
        const monitoringWarnings: string[] = [];
        const statusTimeline: Array<{ status: string; elapsedSeconds: number; observedAt: string }> = [];

        const configuredDurationMs = timeoutFromMatchersMs ?? getDurationMsFromResource(resourceObject);
        const monitorWindowMs = Math.min(
          Math.max((configuredDurationMs ?? 60 * 1000) + 45 * 1000, 60 * 1000),
          4 * 60 * 1000,
        );
        const pollIntervalMs = 5 * 1000;
        const monitorStartMs = Date.now();
        let createdAtMs = createdAtFromCreateBodyMs ?? monitorStartMs;
        const statusPath = `/apis/chaosblade.io/v1alpha1/chaosblades/${encodeURIComponent(identity.name)}`;

        while (Date.now() - monitorStartMs <= monitorWindowMs) {
          const summaryResult = await fetchKubernetesApiJson(
            kubernetesApiUrl,
            token,
            statusPath,
            "GET",
            undefined,
            abortSignal,
          );
          if (summaryResult.success) {
            experimentSummary = summaryResult.value;
            const maybeCreatedAtMs = getChaosBladeCreatedAtMs(experimentSummary);
            if (maybeCreatedAtMs) {
              createdAtMs = maybeCreatedAtMs;
            }
            latestStatus = getChaosBladeStatus(experimentSummary);
            latestElapsedSeconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
            statusTimeline.push({
              status: latestStatus ?? "unknown",
              elapsedSeconds: latestElapsedSeconds,
              observedAt: new Date().toISOString(),
            });
            const failedByStatus = isChaosBladeFailedStatus(latestStatus, experimentSummary);
            if (failedByStatus) {
              terminalStateReached = true;
              break;
            }
            if (latestStatus && !isChaosBladeInProgressStatus(latestStatus)) {
              const shouldContinueForDuration = shouldContinueMonitoringUntilConfiguredDuration(
                monitorStartMs,
                configuredDurationMs,
              );
              if (!shouldContinueForDuration) {
                terminalStateReached = true;
                break;
              }
            }
          } else {
            monitoringWarnings.push(summaryResult.error);
          }

          const nextPollWillExceedWindow =
            Date.now() - monitorStartMs + pollIntervalMs > monitorWindowMs;
          if (nextPollWillExceedWindow) {
            break;
          }
          await sleepWithAbort(pollIntervalMs, abortSignal);
        }

        if (!terminalStateReached && latestStatus && !isChaosBladeInProgressStatus(latestStatus)) {
          terminalStateReached = true;
        }

        const failedByStatus = isChaosBladeFailedStatus(latestStatus, experimentSummary);
        latestElapsedSeconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
        const elapsedText = formatElapsedSeconds(latestElapsedSeconds);
        const executionSuccess = !failedByStatus;

        let message = "Experiment submitted successfully via ChaosBlade Kubernetes API.";
        if (latestStatus) {
          if (terminalStateReached) {
            message = `Experiment reached terminal status "${latestStatus}" after ${elapsedText}.`;
          } else {
            message = `Experiment status is "${latestStatus}" after ${elapsedText}; monitoring window ended.`;
          }
        }
        if (failedByStatus && latestStatus) {
          message = `Experiment reported failure status "${latestStatus}" after ${elapsedText}.`;
        }

        return {
          success: executionSuccess,
          engine: inferredEngine,
          executedVia: "chaosblade-k8s-api",
          clusterName,
          message,
          experiment: {
            apiVersion: identity.apiVersion,
            kind: identity.kind,
            namespace: identity.namespace,
            name: identity.name,
          },
          status: latestStatus,
          elapsedSeconds: latestElapsedSeconds,
          elapsedText,
          terminalStateReached,
          monitoringWindowSeconds: Math.floor(monitorWindowMs / 1000),
          pollIntervalSeconds: Math.floor(pollIntervalMs / 1000),
          statusTimeline: statusTimeline.slice(-30),
          monitoringWarnings: monitoringWarnings.slice(0, 6),
          createResponse: createBody,
          experimentSummary,
        };
      }

      if (!baseUrl) {
        return {
          success: false,
          error:
            "CHAOS_DASHBOARD_URL is required for chaos-mesh execution. Please set cluster endpoint in Chaos 对象集群配置.",
        };
      }

      const createResponse = await fetch(`${baseUrl}/api/experiments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(resourceObject),
        signal: abortSignal,
      });

      const createBodyText = await createResponse.text();
      if (!createResponse.ok) {
        return {
          success: false,
          error: `Failed to execute experiment via Chaos API: status ${createResponse.status}, body: ${createBodyText}`,
        };
      }

      const parsedCreateBody = parseJsonText(createBodyText);
      const createBody = parsedCreateBody.success ? parsedCreateBody.value : createBodyText;
      const createdAtFromCreateBodyMs = getExperimentCreatedAtMs(createBody);

      let experimentSummary: unknown = undefined;
      let latestStatus: string | undefined;
      let latestElapsedSeconds = 0;
      let terminalStateReached = false;
      const monitoringWarnings: string[] = [];
      const statusTimeline: Array<{ status: string; elapsedSeconds: number; observedAt: string }> = [];

      const configuredDurationMs = getDurationMsFromResource(resourceObject);
      const monitorWindowMs = Math.min(
        Math.max((configuredDurationMs ?? 60 * 1000) + 45 * 1000, 60 * 1000),
        4 * 60 * 1000,
      );
      const pollIntervalMs = 5 * 1000;
      const monitorStartMs = Date.now();
      let createdAtMs = createdAtFromCreateBodyMs ?? monitorStartMs;

      if (identity.namespace && identity.name && identity.kind) {
        while (Date.now() - monitorStartMs <= monitorWindowMs) {
          const summaryResult = await fetchExperimentSummary(baseUrl, token, identity, abortSignal);
          if (summaryResult.success) {
            experimentSummary = summaryResult.summary;
            const maybeCreatedAtMs = getExperimentCreatedAtMs(experimentSummary);
            if (maybeCreatedAtMs) {
              createdAtMs = maybeCreatedAtMs;
            }
            latestStatus = getExperimentStatus(experimentSummary);
            latestElapsedSeconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
            statusTimeline.push({
              status: latestStatus ?? "unknown",
              elapsedSeconds: latestElapsedSeconds,
              observedAt: new Date().toISOString(),
            });
            const failedByStatus = isExecutionFailedStatus(latestStatus);
            if (failedByStatus) {
              terminalStateReached = true;
              break;
            }
            if (latestStatus && !isExecutionInProgressStatus(latestStatus)) {
              const shouldContinueForDuration = shouldContinueMonitoringUntilConfiguredDuration(
                monitorStartMs,
                configuredDurationMs,
              );
              if (!shouldContinueForDuration) {
                terminalStateReached = true;
                break;
              }
            }
          } else {
            monitoringWarnings.push(summaryResult.error);
          }

          const nextPollWillExceedWindow =
            Date.now() - monitorStartMs + pollIntervalMs > monitorWindowMs;
          if (nextPollWillExceedWindow) {
            break;
          }
          await sleepWithAbort(pollIntervalMs, abortSignal);
        }
      } else {
        monitoringWarnings.push("Experiment identity is incomplete; skipped status monitoring.");
      }

      if (!terminalStateReached && latestStatus && !isExecutionInProgressStatus(latestStatus)) {
        terminalStateReached = true;
      }

      const failedByStatus = isExecutionFailedStatus(latestStatus);
      latestElapsedSeconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
      const elapsedText = formatElapsedSeconds(latestElapsedSeconds);
      const executionSuccess = !failedByStatus;

      let message = `Experiment submitted successfully via Chaos Dashboard API.`;
      if (latestStatus) {
        if (terminalStateReached) {
          message = `Experiment reached terminal status "${latestStatus}" after ${elapsedText}.`;
        } else {
          message = `Experiment status is "${latestStatus}" after ${elapsedText}; monitoring window ended.`;
        }
      }
      if (failedByStatus && latestStatus) {
        message = `Experiment reported failure status "${latestStatus}" after ${elapsedText}.`;
      }

      return {
        success: executionSuccess,
        engine: inferredEngine,
        executedVia: "chaos-dashboard-api",
        clusterName,
        message,
        experiment: {
          apiVersion: identity.apiVersion,
          kind: identity.kind,
          namespace: identity.namespace,
          name: identity.name,
        },
        status: latestStatus,
        elapsedSeconds: latestElapsedSeconds,
        elapsedText,
        terminalStateReached,
        monitoringWindowSeconds: Math.floor(monitorWindowMs / 1000),
        pollIntervalSeconds: Math.floor(pollIntervalMs / 1000),
        statusTimeline: statusTimeline.slice(-30),
        monitoringWarnings: monitoringWarnings.slice(0, 6),
        createResponse: createBody,
        experimentSummary,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to execute experiment: ${error.message}`,
      };
    }
  },
});
