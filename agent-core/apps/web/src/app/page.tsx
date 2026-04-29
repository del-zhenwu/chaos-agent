"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Link2,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Settings,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ClusterConfig = {
  id: string;
  name: string;
  endpoint: string;
  token: string;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type HistorySession = {
  id: string;
  title: string;
  updatedAt: string;
};

type ToolDisplay = {
  key: string;
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

type AskChoiceOption = {
  label: string;
  description?: string;
  value?: string;
};

type AskChoiceQuestion = {
  header?: string;
  question: string;
  options: AskChoiceOption[];
  multiSelect: boolean;
};

type SelectionContextPayload = {
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

const DEFAULT_CHAT_INPUT_PLACEHOLDER = "Ask me to prepare or run a chaos experiment...";
const MANUAL_TARGET_INPUT_PLACEHOLDER =
  "请手动输入目标信息（例如 namespace=..., kind=..., name=...）";
const CLUSTER_ENDPOINT_PLACEHOLDER = "https://chaos.example.com";

function normalizeClusterEndpoint(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHexCharacter(char: string): boolean {
  const code = char.toLowerCase().charCodeAt(0);
  const isDigit = code >= 48 && code <= 57;
  const isHexLower = code >= 97 && code <= 102;
  return isDigit || isHexLower;
}

function isUuidString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const parts = trimmed.split("-");
  const expectedLengths = [8, 4, 4, 4, 12];
  if (parts.length !== expectedLengths.length) {
    return false;
  }
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.length !== expectedLengths[i]) {
      return false;
    }
    for (const char of part) {
      if (!isHexCharacter(char)) {
        return false;
      }
    }
  }
  return true;
}

function createClientUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
  return `00000000-0000-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, "0")}`;
}

function normalizeClusterIds(clusters: ClusterConfig[]): ClusterConfig[] {
  return clusters.map((cluster) => ({
    ...cluster,
    id: isUuidString(cluster.id) ? cluster.id : createClientUuid(),
    endpoint: normalizeClusterEndpoint((cluster as { endpoint?: unknown }).endpoint),
  }));
}

function isValidClusterEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readApiErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  let rawText = "";
  try {
    rawText = (await response.text()).trim();
  } catch {
    return fallbackMessage;
  }
  if (!rawText) {
    return fallbackMessage;
  }
  if (rawText.startsWith("<!DOCTYPE html")) {
    return fallbackMessage;
  }
  try {
    const parsed = JSON.parse(rawText) as { error?: unknown; message?: unknown };
    const fromError =
      typeof parsed.error === "string" && parsed.error.trim().length > 0
        ? parsed.error.trim()
        : "";
    if (fromError) {
      return fromError;
    }
    const fromMessage =
      typeof parsed.message === "string" && parsed.message.trim().length > 0
        ? parsed.message.trim()
        : "";
    if (fromMessage) {
      return fromMessage;
    }
  } catch {
    if (rawText.length <= 240) {
      return rawText;
    }
  }
  return fallbackMessage;
}

function toUserFriendlyClusterError(message: string): string {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return "保存集群配置失败，请稍后重试。";
  }
  if (normalized.includes("invalid uuid")) {
    return "检测到旧版集群配置 ID，已兼容处理，请重试一次。";
  }
  if (normalized.includes("invalid request body")) {
    return "集群配置格式无效，请检查名称、Endpoint 和 Token。";
  }
  if (normalized.includes("endpoint")) {
    return "集群地址格式无效，请检查 Endpoint 是否正确。";
  }
  if (normalized.includes("failed to save clusters")) {
    return "保存集群配置失败，请稍后重试。";
  }
  return message;
}

function createLocalCluster(name: string, isDefault: boolean): ClusterConfig {
  return {
    id: createClientUuid(),
    name,
    endpoint: "",
    token: "",
    isDefault,
  };
}

function getMessageText(message: UIMessage): string {
  const textParts = message.parts.filter(isTextUIPart).map((part) => part.text);
  if (textParts.length > 0) {
    return textParts.join("");
  }

  const legacyContent = (message as { content?: unknown }).content;
  return typeof legacyContent === "string" ? legacyContent : "";
}

function getToolDisplays(message: UIMessage): ToolDisplay[] {
  const toolParts = message.parts.filter(isToolUIPart).map((part) => {
    return {
      key: `${part.toolCallId}-${part.type}-${part.state}`,
      toolName: getToolName(part),
      state: part.state,
      input: part.input,
      output: "output" in part ? part.output : undefined,
      errorText: "errorText" in part ? part.errorText : undefined,
    };
  });

  if (toolParts.length > 0) {
    return toolParts;
  }

  const legacyToolInvocations = (
    message as {
      toolInvocations?: Array<{
        toolCallId: string;
        toolName: string;
        args?: unknown;
        result?: unknown;
      }>;
    }
  ).toolInvocations;

  if (!legacyToolInvocations) {
    return [];
  }

  return legacyToolInvocations.map((tool) => ({
    key: `${tool.toolCallId}-${tool.toolName}`,
    toolName: tool.toolName,
    state: tool.result ? "output-available" : "input-available",
    input: tool.args,
    output: tool.result,
  }));
}

function getSessionTitle(messages: UIMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const text = getMessageText(message).trim();
    if (text) {
      return text.length > 22 ? `${text.slice(0, 22)}...` : text;
    }
  }
  return "新建任务";
}

function buildQuestionSelectionDisplayMessage(question: AskChoiceQuestion, option: AskChoiceOption): string {
  const lines: string[] = [];
  const normalizedQuestion = question.question.trim();
  const normalizedLabel = option.label.trim();
  const normalizedValue = option.value?.trim() ?? "";
  const normalizedDescription = option.description?.trim() ?? "";

  if (normalizedQuestion) {
    lines.push(`问题：${normalizedQuestion}`);
  }
  if (normalizedLabel) {
    lines.push(`选择：${normalizedLabel}`);
  }
  if (normalizedValue && normalizedValue !== normalizedLabel) {
    lines.push(`标识：${normalizedValue}`);
  }
  if (
    normalizedDescription &&
    normalizedDescription !== normalizedLabel &&
    normalizedDescription !== normalizedValue
  ) {
    lines.push(`说明：${normalizedDescription}`);
  }

  if (lines.length > 0) {
    return lines.join("\n");
  }
  return "已确认执行。";
}

function buildSelectionProgressMessage(question: AskChoiceQuestion, option: AskChoiceOption): string {
  const normalizedValue = option.value?.trim().toLowerCase() ?? "";
  if (normalizedValue === "confirm" || normalizedValue === "execute" || normalizedValue === "run") {
    return "已收到执行确认，正在提交实验并同步平台状态...";
  }

  const normalizedQuestion = question.question.trim();
  if (normalizedQuestion) {
    return `已收到你的选择，正在处理：${normalizedQuestion}`;
  }
  return "已收到你的选择，正在继续处理...";
}

function buildQuestionSelectionContext(
  question: AskChoiceQuestion,
  option: AskChoiceOption,
): SelectionContextPayload {
  const selectedOption = {
    label: option.label.trim(),
    ...(option.value?.trim() ? { value: option.value.trim() } : {}),
    ...(option.description?.trim() ? { description: option.description.trim() } : {}),
  };
  return {
    question: question.question.trim(),
    multiSelect: question.multiSelect,
    selectedOption,
    options: question.options.map((candidate) => ({
      label: candidate.label.trim(),
      ...(candidate.value?.trim() ? { value: candidate.value.trim() } : {}),
      ...(candidate.description?.trim() ? { description: candidate.description.trim() } : {}),
    })),
  };
}

async function fetchHistorySessions(): Promise<HistorySession[]> {
  const response = await fetch("/api/history", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "读取历史任务失败，请稍后重试。"));
  }
  const data = (await response.json()) as { sessions?: HistorySession[] };
  return data.sessions ?? [];
}

async function fetchHistoryMessages(sessionId: string): Promise<UIMessage[]> {
  const response = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "读取会话消息失败，请稍后重试。"));
  }
  const data = (await response.json()) as { messages?: UIMessage[] };
  return data.messages ?? [];
}

async function createHistorySession(title?: string): Promise<HistorySession> {
  const response = await fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "创建会话失败，请稍后重试。"));
  }
  const data = (await response.json()) as { session: HistorySession };
  return data.session;
}

async function saveHistorySession(
  sessionId: string,
  title: string,
  messages: UIMessage[],
): Promise<void> {
  const response = await fetch("/api/history", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, title, messages }),
  });
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "保存聊天记录失败，请稍后重试。"));
  }
}

async function renameHistorySession(
  sessionId: string,
  title: string,
): Promise<HistorySession> {
  const response = await fetch("/api/history", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, title }),
  });
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "重命名任务失败，请稍后重试。"));
  }
  const data = (await response.json()) as { session: HistorySession };
  return data.session;
}

async function deleteHistorySessionById(sessionId: string): Promise<void> {
  const response = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "删除任务失败，请稍后重试。"));
  }
}

async function copyText(text: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to execCommand approach below.
    }
  }
  if (typeof document === "undefined") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const success = document.execCommand("copy");
  document.body.removeChild(textarea);
  return success;
}

async function fetchClusterConfigs(): Promise<ClusterConfig[]> {
  const response = await fetch("/api/clusters", { cache: "no-store" });
  if (!response.ok) {
    const message = await readApiErrorMessage(response, "读取集群配置失败，请稍后重试。");
    throw new Error(toUserFriendlyClusterError(message));
  }
  const data = (await response.json()) as { clusters?: ClusterConfig[] };
  const clusters = normalizeClusterIds(data.clusters ?? []);
  if (clusters.length > 0) {
    return clusters;
  }
  return [createLocalCluster("", true)];
}

function normalizeClusterPayload(
  clusters: ClusterConfig[],
  selectedClusterId: string,
): ClusterConfig[] {
  const nonEmpty = clusters
    .map((cluster) => ({
      ...cluster,
      name: cluster.name.trim(),
      endpoint: normalizeClusterEndpoint(cluster.endpoint),
      token: cluster.token.trim(),
    }))
    .filter((cluster) => cluster.name.length > 0);

  const base = nonEmpty.length > 0 ? nonEmpty : [createLocalCluster("", true)];
  const selected =
    base.find((cluster) => cluster.id === selectedClusterId) ??
    base.find((cluster) => cluster.isDefault) ??
    base[0];

  return base.map((cluster) => ({
    ...cluster,
    isDefault: cluster.id === selected.id,
  }));
}

async function saveClusterConfigs(
  clusters: ClusterConfig[],
  selectedClusterId: string,
): Promise<ClusterConfig[]> {
  const payload = normalizeClusterPayload(normalizeClusterIds(clusters), selectedClusterId);
  const response = await fetch("/api/clusters", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clusters: payload.map((cluster) => ({
        ...(isUuidString(cluster.id) ? { id: cluster.id } : {}),
        name: cluster.name,
        endpoint: cluster.endpoint,
        token: cluster.token,
        isDefault: cluster.isDefault,
      })),
    }),
  });
  if (!response.ok) {
    const message = await readApiErrorMessage(response, "保存集群配置失败，请稍后重试。");
    throw new Error(toUserFriendlyClusterError(message));
  }
  const data = (await response.json()) as { clusters?: ClusterConfig[] };
  return normalizeClusterIds(data.clusters ?? payload);
}

function serializeClusters(clusters: ClusterConfig[]): string {
  return JSON.stringify(
    clusters.map((cluster) => ({
      id: cluster.id,
      name: cluster.name,
      endpoint: cluster.endpoint,
      token: cluster.token,
      isDefault: cluster.isDefault,
    })),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function sanitizeAskQuestionText(rawQuestion: string): string {
  const normalizedQuestion = rawQuestion.trim();
  if (!normalizedQuestion) {
    return "请确认下一步。";
  }

  const yamlStartIndex = normalizedQuestion.indexOf("apiVersion:");
  if (yamlStartIndex >= 0) {
    const briefQuestion = normalizedQuestion.slice(0, yamlStartIndex).trim();
    if (briefQuestion) {
      return `${briefQuestion}（YAML 已在上方卡片展示）`;
    }
    return "请确认是否执行该实验（YAML 已在上方卡片展示）。";
  }

  if (normalizedQuestion.length > 220) {
    return `${normalizedQuestion.slice(0, 220)}...`;
  }

  return normalizedQuestion;
}

function isGenericChoicePrompt(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized === "需要你做选择，请在下方确认。" ||
    normalized === "请从下方选项中选择下一步。" ||
    normalized === "需要你确认下一步。"
  );
}

function getChaosExecutePhase(output: unknown): string | null {
  const outputRecord = asRecord(output);
  if (!outputRecord) {
    return null;
  }

  const summaryRecord = asRecord(outputRecord.experimentSummary);
  const rawPhase =
    outputRecord.status ??
    outputRecord.phase;

  if (typeof rawPhase === "string" && rawPhase.trim().length > 0) {
    return rawPhase.trim().toLowerCase();
  }

  const fallbackPhase = summaryRecord?.status ?? summaryRecord?.Status;
  const fallbackEnginePhase =
    typeof fallbackPhase === "string"
      ? fallbackPhase
      : summaryRecord?.phase ?? summaryRecord?.Phase;
  if (typeof fallbackEnginePhase !== "string") {
    return null;
  }
  return fallbackEnginePhase.trim().toLowerCase();
}

function formatElapsedText(totalSeconds: number): string {
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

function getChaosExecuteElapsedText(output: unknown): string | null {
  const outputRecord = asRecord(output);
  if (!outputRecord) {
    return null;
  }

  if (typeof outputRecord.elapsedText === "string" && outputRecord.elapsedText.trim().length > 0) {
    return outputRecord.elapsedText.trim();
  }

  if (typeof outputRecord.elapsedSeconds === "number" && Number.isFinite(outputRecord.elapsedSeconds)) {
    return formatElapsedText(Math.max(0, Math.floor(outputRecord.elapsedSeconds)));
  }

  const summaryRecord = asRecord(outputRecord.experimentSummary);
  if (!summaryRecord) {
    return null;
  }
  const rawCreated =
    summaryRecord.created ??
    summaryRecord.Created ??
    summaryRecord.creationTimestamp ??
    summaryRecord.CreationTimestamp;
  if (typeof rawCreated !== "string") {
    return null;
  }
  const createdMs = Date.parse(rawCreated);
  if (Number.isNaN(createdMs)) {
    return null;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
  return formatElapsedText(elapsedSeconds);
}

function isExecutionInProgressPhase(phase: string | null): boolean {
  return (
    phase === "injecting" ||
    phase === "running" ||
    phase === "pending" ||
    phase === "creating" ||
    phase === "created"
  );
}

function isExecutionFailurePhase(phase: string | null): boolean {
  return phase === "failed" || phase === "error" || phase === "errored" || phase === "exception";
}

function isExecutionTerminalSuccessPhase(phase: string | null): boolean {
  return (
    phase === "finished" ||
    phase === "paused" ||
    phase === "success" ||
    phase === "completed" ||
    phase === "destroyed"
  );
}

function formatExecutePhaseLabel(phase: string | null, elapsedText?: string | null): string {
  const suffix = elapsedText ? ` ${elapsedText}` : "";
  if (!phase) {
    return `running${suffix}`;
  }
  if (phase === "injecting") {
    return `injecting${suffix}`;
  }
  if (phase === "running") {
    return `running${suffix}`;
  }
  if (phase === "pending") {
    return `pending${suffix}`;
  }
  if (phase === "creating") {
    return `creating${suffix}`;
  }
  if (phase === "created") {
    return `created${suffix}`;
  }
  if (phase === "finished") {
    return `finished${suffix}`;
  }
  if (phase === "paused") {
    return `paused${suffix}`;
  }
  if (phase === "success" || phase === "completed" || phase === "destroyed") {
    return `${phase}${suffix}`;
  }
  if (phase === "failed" || phase === "error" || phase === "errored" || phase === "exception") {
    return `failed${suffix}`;
  }
  return `${phase}${suffix}`;
}

function isCancelOption(option: AskChoiceOption): boolean {
  const label = option.label.trim().toLowerCase();
  const value = option.value?.trim().toLowerCase() ?? "";
  return label === "取消" || label === "cancel" || value === "cancel";
}

function isManualInputOption(option: AskChoiceOption): boolean {
  const label = option.label.trim().toLowerCase();
  const value = option.value?.trim().toLowerCase() ?? "";
  if (value === "manual-input" || value === "other-input" || value === "other") {
    return true;
  }
  return label.includes("其他") || label.includes("other");
}

function isCandidateResourceOption(option: AskChoiceOption): boolean {
  if (isCancelOption(option) || isManualInputOption(option)) {
    return false;
  }
  const value = option.value?.trim();
  if (!value) {
    return false;
  }
  const normalizedValue = value.toLowerCase();
  const controlValues = new Set([
    "confirm",
    "yes",
    "no",
    "execute",
    "run",
    "continue",
    "approve",
    "reject",
    "cancel",
    "manual-input",
    "other",
    "other-input",
  ]);
  return !controlValues.has(normalizedValue);
}

function shouldApplyResourceDisambiguationTemplate(
  options: AskChoiceOption[],
  multiSelect: boolean,
): boolean {
  if (multiSelect || options.length === 0) {
    return false;
  }
  const candidateCount = options.filter((option) => isCandidateResourceOption(option)).length;
  if (candidateCount >= 2) {
    return true;
  }
  return candidateCount >= 1 && options.some((option) => isCancelOption(option));
}

function getManualInputOption(): AskChoiceOption {
  return {
    label: "其它（手动输入）",
    description: "以上候选都不符合，我将输入更准确的资源信息。",
    value: "manual-input",
  };
}

function parseAskChoiceQuestions(input: unknown): AskChoiceQuestion[] {
  const inputRecord = asRecord(input);
  if (!inputRecord || !Array.isArray(inputRecord.questions)) {
    return [];
  }

  const parsedQuestions: AskChoiceQuestion[] = [];

  for (let questionIndex = 0; questionIndex < inputRecord.questions.length; questionIndex += 1) {
    const questionRecord = asRecord(inputRecord.questions[questionIndex]);
    if (!questionRecord) {
      continue;
    }

    const questionText =
      typeof questionRecord.question === "string" && questionRecord.question.trim().length > 0
        ? sanitizeAskQuestionText(questionRecord.question)
        : `问题 ${questionIndex + 1}`;
    const options: AskChoiceOption[] = [];

    if (Array.isArray(questionRecord.options)) {
      for (let optionIndex = 0; optionIndex < questionRecord.options.length; optionIndex += 1) {
        const optionRecord = asRecord(questionRecord.options[optionIndex]);
        if (!optionRecord) {
          continue;
        }

        const label =
          typeof optionRecord.label === "string" && optionRecord.label.trim().length > 0
            ? optionRecord.label.trim()
            : `选项 ${optionIndex + 1}`;
        const description =
          typeof optionRecord.description === "string" &&
          optionRecord.description.trim().length > 0
            ? optionRecord.description.trim()
            : "";
        const value =
          typeof optionRecord.value === "string" && optionRecord.value.trim().length > 0
            ? optionRecord.value.trim()
            : "";

        if (description && value) {
          options.push({ label, description, value });
        } else if (description) {
          options.push({ label, description });
        } else if (value) {
          options.push({ label, value });
        } else {
          options.push({ label });
        }
      }
    }

    let normalizedOptions = options;
    if (
      shouldApplyResourceDisambiguationTemplate(
        normalizedOptions,
        questionRecord.multiSelect === true,
      )
    ) {
      normalizedOptions = normalizedOptions.filter((option) => !isCancelOption(option));
      if (!normalizedOptions.some((option) => isManualInputOption(option))) {
        normalizedOptions = [...normalizedOptions, getManualInputOption()];
      }
      if (normalizedOptions.length > 4) {
        const manualOption = normalizedOptions.find((option) => isManualInputOption(option));
        const nonManualOptions = normalizedOptions.filter((option) => !isManualInputOption(option));
        normalizedOptions = [...nonManualOptions.slice(0, 3), ...(manualOption ? [manualOption] : [])].slice(
          0,
          4,
        );
      }
    }

    const parsedQuestion: AskChoiceQuestion = {
      question: questionText,
      options: normalizedOptions,
      multiSelect: questionRecord.multiSelect === true,
    };
    if (typeof questionRecord.header === "string" && questionRecord.header.trim().length > 0) {
      parsedQuestion.header = questionRecord.header.trim();
    }

    parsedQuestions.push(parsedQuestion);
  }

  return parsedQuestions;
}

function getToolNarrative(tool: ToolDisplay): string {
  const inputRecord = asRecord(tool.input);
  const outputRecord = asRecord(tool.output);
  const isCompleted = tool.state === "output-available";

  if (tool.toolName === "skill") {
    const skill = typeof inputRecord?.skill === "string" ? inputRecord.skill : "unknown-skill";
    return isCompleted ? `技能流程已完成：${skill}` : `正在加载技能流程：${skill}`;
  }
  if (tool.toolName === "chaos_find_pods") {
    const keyword = typeof inputRecord?.keyword === "string" ? inputRecord.keyword : "";
    if (isCompleted) {
      const matchedCount =
        typeof outputRecord?.matchedCount === "number" ? outputRecord.matchedCount : undefined;
      return typeof matchedCount === "number"
        ? `已完成关键词 "${keyword || "-"}" 的 Pod 模糊搜索，找到 ${matchedCount} 个候选。`
        : `已完成关键词 "${keyword || "-"}" 的 Pod 模糊搜索。`;
    }
    return keyword ? `正在按关键词 "${keyword}" 进行 Pod 模糊搜索。` : "正在进行 Pod 模糊搜索。";
  }
  if (tool.toolName === "chaos_get_namespaces") {
    return isCompleted ? "已获取当前集群可用命名空间。" : "正在获取当前集群可用命名空间。";
  }
  if (tool.toolName === "chaos_get_labels") {
    const namespaces = Array.isArray(inputRecord?.namespaces)
      ? inputRecord.namespaces.filter((item): item is string => typeof item === "string")
      : [];
    if (isCompleted) {
      return namespaces.length > 0
        ? `已完成命名空间标签收集：${namespaces.slice(0, 3).join(", ")}${namespaces.length > 3 ? "..." : ""}`
        : "已完成可用标签收集。";
    }
    return namespaces.length > 0
      ? `正在命名空间中收集标签：${namespaces.slice(0, 3).join(", ")}${namespaces.length > 3 ? "..." : ""}`
      : "正在收集可用标签。";
  }
  if (tool.toolName === "chaos_get_pods") {
    const namespace = typeof inputRecord?.namespace === "string" ? inputRecord.namespace : "";
    const selectorRecord = asRecord(inputRecord?.labelSelectors);
    const selectorText = selectorRecord
      ? Object.entries(selectorRecord)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(",")
      : "";
    if (namespace && selectorText) {
      return isCompleted
        ? `已完成 Pod 查询：namespace=${namespace}，selector=${selectorText}`
        : `正在查询 Pod：namespace=${namespace}，selector=${selectorText}`;
    }
    return isCompleted ? "已完成候选标签 Pod 查询。" : "正在根据候选标签查询 Pod。";
  }
  if (tool.toolName === "chaos_prepare") {
    const scenario = typeof inputRecord?.scenario === "string" ? inputRecord.scenario : "";
    const namespace = typeof inputRecord?.namespace === "string" ? inputRecord.namespace : "";
    if (scenario && namespace) {
      return isCompleted
        ? `实验 YAML 已生成：${scenario}（${namespace}）`
        : `正在生成实验 YAML：${scenario}（${namespace}）`;
    }
    return isCompleted ? "实验 YAML 已生成。" : "正在生成实验 YAML。";
  }
  if (tool.toolName === "chaos_execute") {
    const executePhase = getChaosExecutePhase(tool.output);
    const elapsedText = getChaosExecuteElapsedText(tool.output);
    const elapsedSuffix = elapsedText ? `（已进行 ${elapsedText}）` : "";
    if (executePhase === "injecting") {
      return `实验已提交，当前处于注入中${elapsedSuffix}。`;
    }
    if (executePhase === "running") {
      return `实验正在运行中${elapsedSuffix}。`;
    }
    if (executePhase === "pending" || executePhase === "creating") {
      return `实验已提交，正在等待平台处理${elapsedSuffix}。`;
    }
    if (executePhase === "finished" || executePhase === "paused") {
      return `实验已结束，状态为 ${executePhase}${elapsedSuffix}。`;
    }
    if (executePhase === "failed" || executePhase === "error" || executePhase === "errored") {
      return `实验执行异常，状态为 ${executePhase}${elapsedSuffix}。`;
    }
    return "正在执行实验配置。";
  }
  if (tool.toolName === "ask_user_question") {
    const questions = parseAskChoiceQuestions(tool.input);
    if (questions.length > 0) {
      return "需要你做选择，请在下方确认。";
    }
    return "需要你确认下一步。";
  }

  if (tool.state === "input-streaming") {
    return "正在执行工具并收集结果。";
  }
  if (tool.state === "output-available") {
    return "该步骤已完成。";
  }
  if (tool.state === "output-error") {
    return "该步骤执行失败，等待处理。";
  }
  return "正在准备该步骤。";
}

function getDisplayOutputForTool(tool: ToolDisplay): unknown {
  if (tool.toolName !== "skill") {
    return tool.output;
  }
  const outputRecord = asRecord(tool.output);
  if (!outputRecord) {
    return tool.output;
  }

  const safeOutput: Record<string, unknown> = {};
  if ("success" in outputRecord) {
    safeOutput.success = outputRecord.success;
  }
  if ("skillName" in outputRecord) {
    safeOutput.skillName = outputRecord.skillName;
  }
  if ("message" in outputRecord) {
    safeOutput.message = outputRecord.message;
  }

  return safeOutput;
}

function ToolInvocation({
  tool,
  onSelectQuestionOption,
}: {
  tool: ToolDisplay;
  onSelectQuestionOption?: (question: AskChoiceQuestion, option: AskChoiceOption) => void;
}) {
  const [isOpen, setIsOpen] = useState(tool.state !== "output-available");
  const hasStructuredFailure =
    tool.state === "output-available" &&
    typeof tool.output === "object" &&
    tool.output !== null &&
    "success" in tool.output &&
    (tool.output as { success?: unknown }).success === false;
  const isAwaitingUser =
    tool.toolName === "ask_user_question" &&
    (tool.state === "input-available" || tool.state === "input-streaming");
  const isAskUserQuestion = tool.toolName === "ask_user_question";
  const executePhase = tool.toolName === "chaos_execute" ? getChaosExecutePhase(tool.output) : null;
  const executeElapsedText =
    tool.toolName === "chaos_execute" ? getChaosExecuteElapsedText(tool.output) : null;
  const isExecutionInProgress =
    tool.toolName === "chaos_execute" && isExecutionInProgressPhase(executePhase);
  const isExecutionFailed =
    tool.toolName === "chaos_execute" && isExecutionFailurePhase(executePhase);
  const isExecutionTerminalSuccess =
    tool.toolName === "chaos_execute" && isExecutionTerminalSuccessPhase(executePhase);
  const isToolInputPending =
    (tool.state === "input-available" || tool.state === "input-streaming") && !isAwaitingUser;
  const isRunning = isToolInputPending || isExecutionInProgress;
  const hasOutput = tool.state === "output-available";
  const displayOutput = getDisplayOutputForTool(tool);
  const hasDisplayOutput = hasOutput && displayOutput !== undefined;
  const hasError = tool.state === "output-error" || hasStructuredFailure || isExecutionFailed;
  const statusText = hasError
    ? "failed"
    : isAwaitingUser
      ? "waiting-user"
      : isToolInputPending
        ? "running"
      : executePhase
        ? formatExecutePhaseLabel(executePhase, executeElapsedText)
        : hasOutput
          ? "done"
          : tool.state;
  const narrative = getToolNarrative(tool);
  const askChoiceQuestions =
    tool.toolName === "ask_user_question" ? parseAskChoiceQuestions(tool.input) : [];
  const statusClassName = hasError
    ? "bg-red-100 text-red-600"
    : isAwaitingUser
      ? "bg-amber-100 text-amber-700"
      : isRunning
        ? "bg-blue-100 text-blue-700"
      : isExecutionTerminalSuccess
        ? "bg-emerald-100 text-emerald-700"
      : "bg-zinc-100 text-zinc-500";

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        className="flex w-full items-center justify-between p-2.5 text-xs font-mono text-zinc-600 transition-colors hover:bg-zinc-50"
      >
        <div className="flex min-w-0 items-center gap-2 font-semibold text-zinc-800">
          {isAwaitingUser ? (
            <MessageSquare size={14} className="text-amber-600" />
          ) : isRunning ? (
            <Loader2 size={14} className="animate-spin text-blue-600" />
          ) : (
            <Terminal size={14} className="text-zinc-400" />
          )}
          <span className="shrink-0">{tool.toolName}</span>
          {!isAskUserQuestion && (
            <span className="hidden truncate text-[10px] font-normal text-zinc-500 lg:block">
              {narrative}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${statusClassName}`}>
            {statusText}
          </span>
          {isOpen ? (
            <ChevronDown size={14} className="text-zinc-400" />
          ) : (
            <ChevronRight size={14} className="text-zinc-400" />
          )}
        </div>
      </button>

      {isOpen && (
        <div className="overflow-x-auto border-t border-zinc-100 bg-zinc-50 p-3 text-[11px] font-mono text-zinc-600">
          {!isAskUserQuestion && (
            <div className="mb-3 rounded-md border border-zinc-200 bg-white px-3 py-2 text-[12px] font-sans text-zinc-700">
              {narrative}
            </div>
          )}

          {tool.toolName === "ask_user_question" && askChoiceQuestions.length > 0 ? (
            <div className="space-y-3 font-sans">
              {askChoiceQuestions.map((question, questionIndex) => (
                <div
                  key={`${tool.key}-question-${questionIndex}`}
                  className="rounded-md border border-zinc-200 bg-white p-3"
                >
                  {question.header && (
                    <div className="text-[11px] font-semibold text-zinc-500">{question.header}</div>
                  )}
                  {!isGenericChoicePrompt(question.question) && (
                    <div className="mt-1 text-[13px] leading-relaxed text-zinc-800">
                      {question.question}
                    </div>
                  )}
                  <div className="mt-3 space-y-2">
                    {question.options.map((option, optionIndex) => (
                      <button
                        key={`${tool.key}-option-${questionIndex}-${optionIndex}`}
                        type="button"
                        disabled={
                          !isAwaitingUser ||
                          !onSelectQuestionOption ||
                          question.multiSelect
                        }
                        onClick={() => onSelectQuestionOption?.(question, option)}
                        className="flex w-full items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-left transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <span className="mt-0.5 text-[11px] font-semibold text-zinc-500">
                          {optionIndex + 1}.
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-medium text-zinc-800">
                            {option.label}
                          </span>
                          {option.value && (
                            <span className="block font-mono text-[10px] text-zinc-400">
                              {option.value}
                            </span>
                          )}
                          {option.description && (
                            <span className="block text-[11px] text-zinc-500">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                  {question.multiSelect && (
                    <div className="mt-2 text-[11px] text-zinc-500">
                      当前题目允许多选，请在输入框回复多个选项。
                    </div>
                  )}
                </div>
              ))}
              {hasOutput && (
                <details className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-[11px] text-zinc-500">
                  <summary className="cursor-pointer font-medium">查看问答结果 JSON</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-all">
                    {JSON.stringify(tool.output, null, 2)}
                  </pre>
                </details>
              )}
              {tool.input !== undefined && (
                <details className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-[11px] text-zinc-500">
                  <summary className="cursor-pointer font-medium">查看原始请求 JSON</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-all">
                    {JSON.stringify(tool.input, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ) : (
            <>
              {tool.input !== undefined && (
                <div className="mb-3">
                  <span className="font-bold text-zinc-400">Input:</span>
                  <pre className="mt-1 whitespace-pre-wrap break-all">
                    {JSON.stringify(tool.input, null, 2)}
                  </pre>
                </div>
              )}

              {hasDisplayOutput && (
                <div>
                  <span className="font-bold text-zinc-400">Output:</span>
                  <pre
                    className={`mt-1 whitespace-pre-wrap break-all ${
                      hasStructuredFailure ? "text-red-600" : "text-emerald-700"
                    }`}
                  >
                    {JSON.stringify(displayOutput, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}

          {hasError && (
            <div>
              <span className="font-bold text-zinc-400">Error:</span>
              <pre className="mt-1 whitespace-pre-wrap break-all text-red-600">
                {tool.errorText || "Unknown error"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChaosPrepareCard({
  result,
}: {
  result: {
    directory?: string;
    message?: string;
    yamlContent?: string;
    scenario?: string;
    namespace?: string;
    duration?: string;
    labelSelectors?: Record<string, string>;
    podNames?: string[];
  };
}) {
  const [activeTab, setActiveTab] = useState<"info" | "yaml">("info");

  return (
    <div className="w-full overflow-hidden rounded-lg border border-zinc-200 bg-white text-sm shadow-sm">
      <div className="flex items-center gap-1 border-b border-zinc-100 bg-zinc-50/80 px-2 py-1.5">
        <button
          onClick={() => setActiveTab("info")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
            activeTab === "info"
              ? "border border-zinc-200/50 bg-white text-blue-600 shadow-sm"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          }`}
        >
          Experiment Info
        </button>
        <button
          onClick={() => setActiveTab("yaml")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
            activeTab === "yaml"
              ? "border border-zinc-200/50 bg-white text-blue-600 shadow-sm"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          }`}
        >
          YAML Preview
        </button>
      </div>
      <div className="p-4">
        {activeTab === "info" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-blue-50 p-2 text-blue-600">
                <FileText size={20} />
              </div>
              <div>
                <h3 className="text-[13px] leading-tight font-medium text-zinc-900">
                  Configuration Prepared
                </h3>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                  {result.message || "YAML has been prepared."}
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <div>
                  <div className="mb-1 text-[9px] font-bold tracking-wider text-zinc-400 uppercase">
                    Target Directory
                  </div>
                  <div
                    className="truncate font-mono text-xs text-zinc-700"
                    title={result.directory || ""}
                  >
                    {result.directory || "-"}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[9px] font-bold tracking-wider text-zinc-400 uppercase">
                    Status
                  </div>
                  <div className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <Check size={12} /> Ready to apply
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[9px] font-bold tracking-wider text-zinc-400 uppercase">
                    Namespace
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-700" title={result.namespace || ""}>
                    {result.namespace || "-"}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[9px] font-bold tracking-wider text-zinc-400 uppercase">
                    Duration
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-700" title={result.duration || ""}>
                    {result.duration || "-"}
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="mb-1 text-[9px] font-bold tracking-wider text-zinc-400 uppercase">
                    Verified Target
                  </div>
                  <div className="text-xs text-zinc-700">
                    {result.podNames && result.podNames.length > 0
                      ? result.podNames.join(", ")
                      : result.labelSelectors && Object.keys(result.labelSelectors).length > 0
                        ? Object.entries(result.labelSelectors)
                            .map(([key, value]) => `${key}=${value}`)
                            .join(", ")
                        : "-"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {activeTab === "yaml" && (
          <pre className="overflow-x-auto rounded-lg border border-zinc-100 bg-[#fafafa] p-3 font-mono text-[11px] leading-relaxed text-zinc-700">
            {result.yamlContent || "YAML content not available"}
          </pre>
        )}
      </div>
    </div>
  );
}

export default function Chat() {
  const [clusters, setClusters] = useState<ClusterConfig[]>([]);
  const [selectedClusterId, setSelectedClusterId] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const [isRenameSessionModalOpen, setIsRenameSessionModalOpen] = useState(false);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameSessionTitle, setRenameSessionTitle] = useState("");
  const [renameSessionError, setRenameSessionError] = useState("");
  const [isDeleteSessionModalOpen, setIsDeleteSessionModalOpen] = useState(false);
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [deleteSessionTitle, setDeleteSessionTitle] = useState("");
  const [deleteSessionError, setDeleteSessionError] = useState("");
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [sessionActionNotice, setSessionActionNotice] = useState("");
  const [isHistoryReady, setIsHistoryReady] = useState(false);
  const [isHistorySaving, setIsHistorySaving] = useState(false);
  const [historyDisabledReason, setHistoryDisabledReason] = useState("");
  const [isClusterReady, setIsClusterReady] = useState(false);
  const [isClusterSaving, setIsClusterSaving] = useState(false);
  const [clusterSyncError, setClusterSyncError] = useState("");
  const [isClusterSettingsOpen, setIsClusterSettingsOpen] = useState(false);
  const [isClusterModalOpen, setIsClusterModalOpen] = useState(false);
  const [editingClusterId, setEditingClusterId] = useState<string | null>(null);
  const [clusterFormName, setClusterFormName] = useState("");
  const [clusterFormEndpoint, setClusterFormEndpoint] = useState("");
  const [clusterFormToken, setClusterFormToken] = useState("");
  const [clusterFormIsDefault, setClusterFormIsDefault] = useState(false);
  const [clusterFormError, setClusterFormError] = useState("");
  const [input, setInput] = useState("");
  const [inputPlaceholder, setInputPlaceholder] = useState(DEFAULT_CHAT_INPUT_PLACEHOLDER);
  const [pendingProgressText, setPendingProgressText] = useState("");

  const hasInitializedHistory = useRef(false);
  const lastSavedSnapshot = useRef("");
  const lastSavedClustersSnapshot = useRef("");
  const composerInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!sessionActionNotice) {
      return;
    }
    const timeout = window.setTimeout(() => setSessionActionNotice(""), 2400);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [sessionActionNotice]);

  const selectedCluster =
    clusters.find((cluster) => cluster.id === selectedClusterId) ??
    clusters.find((cluster) => cluster.isDefault) ??
    clusters[0] ??
    {
      id: "",
      name: "",
      endpoint: "",
      token: "",
      isDefault: true,
    };

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/chat",
        body: {
          clusterName: selectedCluster.name,
          sessionId: activeSessionId || undefined,
        },
      }),
    [activeSessionId, selectedCluster.name],
  );

  const chat = useChat<UIMessage>({
    transport,
    onFinish: () => {
      setPendingProgressText("");
    },
    onError: () => {
      setPendingProgressText("");
    },
  });

  const messages = chat.messages;
  const isLoading = chat.status === "submitted" || chat.status === "streaming";

  useEffect(() => {
    if (hasInitializedHistory.current) {
      return;
    }
    hasInitializedHistory.current = true;

    const bootstrap = async () => {
      try {
        const initialClusters = await fetchClusterConfigs();
        const defaultCluster =
          initialClusters.find((cluster) => cluster.isDefault) ?? initialClusters[0];
        setClusters(initialClusters);
        setSelectedClusterId(defaultCluster?.id ?? "");
        lastSavedClustersSnapshot.current = serializeClusters(
          normalizeClusterPayload(initialClusters, defaultCluster?.id ?? ""),
        );
        setClusterSyncError("");
      } catch (error) {
        console.error("Failed to initialize clusters:", error);
        const fallbackCluster = createLocalCluster("", true);
        setClusters([fallbackCluster]);
        setSelectedClusterId(fallbackCluster.id);
        lastSavedClustersSnapshot.current = serializeClusters([fallbackCluster]);
        setClusterSyncError(error instanceof Error ? error.message : "Cluster database is unavailable.");
      } finally {
        setIsClusterReady(true);
      }

      try {
        const sessionList = await fetchHistorySessions();
        setSessions(sessionList);

        if (sessionList.length > 0) {
          const requestedSessionId =
            typeof window !== "undefined"
              ? new URLSearchParams(window.location.search).get("sessionId")
              : null;
          const initialSession =
            (requestedSessionId
              ? sessionList.find((session) => session.id === requestedSessionId)
              : undefined) ?? sessionList[0];
          const initialMessages = await fetchHistoryMessages(initialSession.id);
          chat.setMessages(initialMessages);
          setActiveSessionId(initialSession.id);
          lastSavedSnapshot.current = JSON.stringify(initialMessages);
        } else {
          const createdSession = await createHistorySession();
          setSessions([createdSession]);
          setActiveSessionId(createdSession.id);
          chat.setMessages([]);
          lastSavedSnapshot.current = "[]";
        }
      } catch (error) {
        console.error("Failed to initialize history:", error);
        const fallbackSession: HistorySession = {
          id: `local-${Date.now()}`,
          title: "当前会话",
          updatedAt: new Date().toISOString(),
        };
        setHistoryDisabledReason(
          error instanceof Error ? error.message : "History database is unavailable.",
        );
        setSessions([fallbackSession]);
        setActiveSessionId(fallbackSession.id);
        chat.setMessages([]);
        lastSavedSnapshot.current = "[]";
      } finally {
        setIsHistoryReady(true);
      }
    };

    void bootstrap();
  }, [chat]);

  useEffect(() => {
    if (
      historyDisabledReason ||
      !isHistoryReady ||
      !activeSessionId ||
      chat.status !== "ready" ||
      activeSessionId.startsWith("local-")
    ) {
      return;
    }

    const snapshot = JSON.stringify(messages);
    if (snapshot === lastSavedSnapshot.current) {
      return;
    }

    const derivedTitle = getSessionTitle(messages);
    const existingTitle = sessions.find((session) => session.id === activeSessionId)?.title?.trim() ?? "";
    const title = existingTitle && existingTitle !== "新建任务" ? existingTitle : derivedTitle;
    setIsHistorySaving(true);

    void saveHistorySession(activeSessionId, title, messages)
      .then(() => {
        lastSavedSnapshot.current = snapshot;
        setSessions((previousSessions) => {
          const remainingSessions = previousSessions.filter((session) => session.id !== activeSessionId);
          return [{ id: activeSessionId, title, updatedAt: new Date().toISOString() }, ...remainingSessions];
        });
      })
      .catch((error) => {
        console.error("Failed to save history:", error);
      })
      .finally(() => {
        setIsHistorySaving(false);
      });
  }, [activeSessionId, historyDisabledReason, isHistoryReady, messages, chat.status, sessions]);

  useEffect(() => {
    if (!isClusterReady || clusters.length === 0) {
      return;
    }

    const payload = normalizeClusterPayload(clusters, selectedClusterId);
    const snapshot = serializeClusters(payload);

    if (snapshot === lastSavedClustersSnapshot.current) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setIsClusterSaving(true);
      void saveClusterConfigs(payload, selectedClusterId)
        .then((savedClusters) => {
          setClusters(savedClusters);
          const defaultCluster =
            savedClusters.find((cluster) => cluster.isDefault) ?? savedClusters[0];
          setSelectedClusterId((previousId) =>
            savedClusters.some((cluster) => cluster.id === previousId)
              ? previousId
              : (defaultCluster?.id ?? ""),
          );
          setClusterSyncError("");
          lastSavedClustersSnapshot.current = serializeClusters(savedClusters);
        })
        .catch((error) => {
          console.error("Failed to save clusters:", error);
          setClusterSyncError(error instanceof Error ? error.message : "Failed to save clusters.");
        })
        .finally(() => {
          setIsClusterSaving(false);
        });
    }, 500);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [clusters, isClusterReady, selectedClusterId]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInput(event.target.value);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const question = input.trim();
    if (!question || isLoading || !isHistoryReady || !isClusterReady) {
      return;
    }

    const pendingClusters = normalizeClusterPayload(clusters, selectedClusterId);
    const pendingClusterSnapshot = serializeClusters(pendingClusters);
    if (pendingClusterSnapshot !== lastSavedClustersSnapshot.current) {
      setIsClusterSaving(true);
      try {
        const savedClusters = await saveClusterConfigs(pendingClusters, selectedClusterId);
        setClusters(savedClusters);
        const defaultCluster =
          savedClusters.find((cluster) => cluster.isDefault) ?? savedClusters[0];
        setSelectedClusterId((previousId) =>
          savedClusters.some((cluster) => cluster.id === previousId)
            ? previousId
            : (defaultCluster?.id ?? ""),
        );
        setClusterSyncError("");
        lastSavedClustersSnapshot.current = serializeClusters(savedClusters);
      } catch (error) {
        console.error("Failed to save clusters before submit:", error);
        setClusterSyncError(error instanceof Error ? error.message : "Failed to save clusters.");
        setIsClusterSaving(false);
        return;
      }
      setIsClusterSaving(false);
    }

    let sessionId = activeSessionId;
    if (!sessionId) {
      if (historyDisabledReason) {
        const localSession: HistorySession = {
          id: `local-${Date.now()}`,
          title: "当前会话",
          updatedAt: new Date().toISOString(),
        };
        setSessions([localSession]);
        setActiveSessionId(localSession.id);
        sessionId = localSession.id;
      } else {
        const createdSession = await createHistorySession(question);
        setSessions((previousSessions) => [createdSession, ...previousSessions]);
        setActiveSessionId(createdSession.id);
        sessionId = createdSession.id;
      }
    }

    setInput("");
    setInputPlaceholder(DEFAULT_CHAT_INPUT_PLACEHOLDER);
    setPendingProgressText(`已收到你的请求，正在处理：${question}`);
    await chat.sendMessage(
      { text: question },
      {
        body: {
          clusterName: selectedCluster.name,
          sessionId,
        },
      },
    );
  };

  const handleQuestionOptionSelect = (question: AskChoiceQuestion, option: AskChoiceOption) => {
    if (isLoading || !isHistoryReady || !isClusterReady) {
      return;
    }
    if (isManualInputOption(option)) {
      setPendingProgressText("");
      setInput("");
      setInputPlaceholder(MANUAL_TARGET_INPUT_PLACEHOLDER);
      composerInputRef.current?.focus();
      return;
    }
    setInputPlaceholder(DEFAULT_CHAT_INPUT_PLACEHOLDER);
    const answerText = buildQuestionSelectionDisplayMessage(question, option);
    const selectionContext = buildQuestionSelectionContext(question, option);
    setPendingProgressText(buildSelectionProgressMessage(question, option));
    void chat.sendMessage(
      { text: answerText },
      {
        body: {
          clusterName: selectedCluster.name,
          sessionId: activeSessionId || undefined,
          selectionContext,
        },
      },
    );
  };

  const handleNewTask = async () => {
    setOpenSessionMenuId(null);
    if (historyDisabledReason) {
      const localSession: HistorySession = {
        id: `local-${Date.now()}`,
        title: "当前会话",
        updatedAt: new Date().toISOString(),
      };
      setSessions([localSession]);
      setActiveSessionId(localSession.id);
      chat.setMessages([]);
      lastSavedSnapshot.current = "[]";
      setInput("");
      setInputPlaceholder(DEFAULT_CHAT_INPUT_PLACEHOLDER);
      setPendingProgressText("");
      return;
    }

    const createdSession = await createHistorySession();
    setSessions((previousSessions) => [createdSession, ...previousSessions]);
    setActiveSessionId(createdSession.id);
    chat.setMessages([]);
    lastSavedSnapshot.current = "[]";
    setInput("");
    setInputPlaceholder(DEFAULT_CHAT_INPUT_PLACEHOLDER);
    setPendingProgressText("");
  };

  const handleSelectSession = async (sessionId: string) => {
    if (historyDisabledReason) {
      return;
    }
    if (sessionId === activeSessionId) {
      return;
    }
    setOpenSessionMenuId(null);
    const sessionMessages = await fetchHistoryMessages(sessionId);
    chat.setMessages(sessionMessages);
    setActiveSessionId(sessionId);
    lastSavedSnapshot.current = JSON.stringify(sessionMessages);
    setPendingProgressText("");
  };

  const openRenameSessionModal = (session: HistorySession) => {
    setOpenSessionMenuId(null);
    setRenameSessionId(session.id);
    setRenameSessionTitle(session.title);
    setRenameSessionError("");
    setIsRenameSessionModalOpen(true);
  };

  const closeRenameSessionModal = () => {
    setIsRenameSessionModalOpen(false);
    setRenameSessionId(null);
    setRenameSessionTitle("");
    setRenameSessionError("");
  };

  const openDeleteSessionModal = (session: HistorySession) => {
    setOpenSessionMenuId(null);
    setDeleteSessionId(session.id);
    setDeleteSessionTitle(session.title);
    setDeleteSessionError("");
    setIsDeleteSessionModalOpen(true);
  };

  const closeDeleteSessionModal = () => {
    if (isDeletingSession) {
      return;
    }
    setIsDeleteSessionModalOpen(false);
    setDeleteSessionId(null);
    setDeleteSessionTitle("");
    setDeleteSessionError("");
  };

  const handleShareSession = async (sessionId: string) => {
    setOpenSessionMenuId(null);
    if (typeof window === "undefined") {
      return;
    }
    const sharedUrl = `${window.location.origin}${window.location.pathname}?sessionId=${encodeURIComponent(sessionId)}`;
    const copied = await copyText(sharedUrl);
    if (copied) {
      setSessionActionNotice("分享链接已复制");
      return;
    }
    setSessionActionNotice("无法自动复制，请手动复制链接");
    window.prompt("复制以下链接", sharedUrl);
  };

  const handleConfirmRenameSession = async () => {
    const sessionId = renameSessionId;
    const normalizedTitle = renameSessionTitle.trim();
    if (!sessionId) {
      return;
    }
    if (!normalizedTitle) {
      setRenameSessionError("请输入任务名称");
      return;
    }
    try {
      if (historyDisabledReason || sessionId.startsWith("local-")) {
        setSessions((previous) =>
          previous.map((session) =>
            session.id === sessionId
              ? { ...session, title: normalizedTitle, updatedAt: new Date().toISOString() }
              : session,
          ),
        );
      } else {
        const updated = await renameHistorySession(sessionId, normalizedTitle);
        setSessions((previous) =>
          previous.map((session) => (session.id === sessionId ? updated : session)),
        );
      }
      closeRenameSessionModal();
      setSessionActionNotice("任务已重命名");
    } catch (error) {
      setRenameSessionError(error instanceof Error ? error.message : "重命名失败，请稍后重试。");
    }
  };

  const handleConfirmDeleteSession = async () => {
    const sessionId = deleteSessionId;
    if (!sessionId) {
      return;
    }
    setDeleteSessionError("");
    setIsDeletingSession(true);
    try {
      if (!historyDisabledReason && !sessionId.startsWith("local-")) {
        await deleteHistorySessionById(sessionId);
      }
      const remainingSessions = sessions.filter((session) => session.id !== sessionId);
      if (remainingSessions.length === 0) {
        if (historyDisabledReason) {
          const fallbackSession: HistorySession = {
            id: `local-${Date.now()}`,
            title: "当前会话",
            updatedAt: new Date().toISOString(),
          };
          setSessions([fallbackSession]);
          setActiveSessionId(fallbackSession.id);
        } else {
          const createdSession = await createHistorySession();
          setSessions([createdSession]);
          setActiveSessionId(createdSession.id);
        }
        chat.setMessages([]);
        lastSavedSnapshot.current = "[]";
        setIsDeleteSessionModalOpen(false);
        setDeleteSessionId(null);
        setDeleteSessionTitle("");
        setSessionActionNotice("任务已删除");
        return;
      }

      setSessions(remainingSessions);
      if (activeSessionId === sessionId) {
        const fallbackSession = remainingSessions[0];
        if (!historyDisabledReason && !fallbackSession.id.startsWith("local-")) {
          const fallbackMessages = await fetchHistoryMessages(fallbackSession.id);
          chat.setMessages(fallbackMessages);
          lastSavedSnapshot.current = JSON.stringify(fallbackMessages);
        } else {
          chat.setMessages([]);
          lastSavedSnapshot.current = "[]";
        }
        setActiveSessionId(fallbackSession.id);
      }
      setIsDeleteSessionModalOpen(false);
      setDeleteSessionId(null);
      setDeleteSessionTitle("");
      setSessionActionNotice("任务已删除");
    } catch (error) {
      setDeleteSessionError(error instanceof Error ? error.message : "删除任务失败，请稍后重试。");
    } finally {
      setIsDeletingSession(false);
    }
  };

  const openCreateClusterModal = () => {
    setEditingClusterId(null);
    setClusterFormName("");
    setClusterFormEndpoint("");
    setClusterFormToken("");
    setClusterFormIsDefault(clusters.length === 0);
    setClusterFormError("");
    setIsClusterModalOpen(true);
  };

  const openEditClusterModal = (cluster: ClusterConfig) => {
    setEditingClusterId(cluster.id);
    setClusterFormName(cluster.name);
    setClusterFormEndpoint(normalizeClusterEndpoint(cluster.endpoint));
    setClusterFormToken(cluster.token);
    setClusterFormIsDefault(cluster.isDefault);
    setClusterFormError("");
    setIsClusterModalOpen(true);
  };

  const closeClusterModal = () => {
    setIsClusterModalOpen(false);
    setEditingClusterId(null);
    setClusterFormError("");
  };

  const openClusterSettingsPanel = () => {
    setIsClusterSettingsOpen(true);
  };

  const closeClusterSettingsPanel = () => {
    setIsClusterSettingsOpen(false);
  };

  const openCreateClusterModalFromPanel = () => {
    closeClusterSettingsPanel();
    openCreateClusterModal();
  };

  const openEditClusterModalFromPanel = (cluster: ClusterConfig) => {
    closeClusterSettingsPanel();
    openEditClusterModal(cluster);
  };

  const handleSaveClusterModal = () => {
    const normalizedName = clusterFormName.trim();
    if (!normalizedName) {
      setClusterFormError("请输入集群名称");
      return;
    }

    const normalizedEndpoint = clusterFormEndpoint.trim();
    if (!normalizedEndpoint) {
      setClusterFormError("请输入 Chaos 平台地址");
      return;
    }
    if (!isValidClusterEndpoint(normalizedEndpoint)) {
      setClusterFormError("平台地址格式无效，请输入 http:// 或 https:// 开头的地址");
      return;
    }

    const normalizedToken = clusterFormToken.trim();
    const editing = editingClusterId;
    const targetId = editing ?? createLocalCluster(normalizedName, clusterFormIsDefault).id;

    let nextClusters = editing
      ? clusters.map((cluster) =>
          cluster.id === editing
            ? {
                ...cluster,
                name: normalizedName,
                endpoint: normalizedEndpoint,
                token: normalizedToken,
                isDefault: clusterFormIsDefault,
              }
            : cluster,
        )
      : [
          ...clusters,
          {
            id: targetId,
            name: normalizedName,
            endpoint: normalizedEndpoint,
            token: normalizedToken,
            isDefault: clusterFormIsDefault || clusters.length === 0,
          },
        ];

    if (clusterFormIsDefault) {
      nextClusters = nextClusters.map((cluster) => ({
        ...cluster,
        isDefault: cluster.id === targetId,
      }));
      setSelectedClusterId(targetId);
    } else if (!nextClusters.some((cluster) => cluster.isDefault) && nextClusters.length > 0) {
      nextClusters = nextClusters.map((cluster, index) => ({
        ...cluster,
        isDefault: index === 0,
      }));
    }

    if (!selectedClusterId) {
      setSelectedClusterId(targetId);
    }

    setClusters(nextClusters);
    closeClusterModal();
  };

  return (
    <div className="flex h-screen bg-white font-sans text-zinc-900">
      <div className="flex w-[260px] flex-shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
        <div className="p-3">
          <button
            onClick={() => void handleNewTask()}
            className="flex w-full items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-zinc-100"
          >
            <Plus size={16} />
            新建任务
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-2 px-2 text-xs font-semibold text-zinc-500">历史任务列表-聊天记录</div>
          {openSessionMenuId && (
            <div
              className="fixed inset-0 z-20"
              onClick={() => setOpenSessionMenuId(null)}
            />
          )}
          <div className="space-y-1">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`relative flex items-center gap-1 rounded-md px-1 py-1 text-sm transition-colors ${
                  session.id === activeSessionId
                    ? "bg-zinc-200 text-zinc-900"
                    : "text-zinc-700 hover:bg-zinc-200"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void handleSelectSession(session.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
                >
                  <MessageSquare size={16} className="shrink-0 text-zinc-400" />
                  <span className="truncate">{session.title}</span>
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenSessionMenuId((current) => (current === session.id ? null : session.id));
                  }}
                  className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-300/70 hover:text-zinc-700"
                  aria-label="打开任务操作菜单"
                  title="任务操作"
                >
                  <MoreHorizontal size={14} />
                </button>
                {openSessionMenuId === session.id && (
                  <div className="absolute top-[calc(100%+4px)] right-1 z-30 w-36 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl">
                    <button
                      type="button"
                      onClick={() => void handleShareSession(session.id)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100"
                    >
                      <Link2 size={14} />
                      分享
                    </button>
                    <button
                      type="button"
                      onClick={() => openRenameSessionModal(session)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100"
                    >
                      <Pencil size={14} />
                      重命名
                    </button>
                    <button
                      type="button"
                      onClick={() => openDeleteSessionModal(session)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
                    >
                      <Trash2 size={14} />
                      删除
                    </button>
                  </div>
                )}
              </div>
            ))}
            {sessions.length === 0 && (
              <div className="px-3 py-2 text-xs italic text-zinc-400">暂无历史记录</div>
            )}
          </div>
          {sessionActionNotice && (
            <div className="mt-2 px-2 text-[11px] text-zinc-500">{sessionActionNotice}</div>
          )}
        </div>

        <div className="border-t border-zinc-200 bg-zinc-50/50 p-4">
          <div className="flex items-center justify-between text-xs font-semibold text-zinc-500">
            <div className="flex items-center gap-1.5">
              <Settings size={14} /> Chaos 对象集群配置
            </div>
            <button
              type="button"
              onClick={openClusterSettingsPanel}
              className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700"
              title="打开集群配置列表"
              aria-label="打开集群配置列表"
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="absolute top-0 right-0 left-0 z-10 flex h-14 items-center justify-center border-b border-zinc-100 bg-white/80 backdrop-blur-md">
          <h1 className="text-base font-semibold text-zinc-800">Chaos Agent</h1>
        </header>

        <div className="flex-1 overflow-y-auto px-4 pt-14 pb-24 scroll-smooth">
          <div className="mx-auto max-w-5xl space-y-6 py-6">
            {messages.length === 0 ? (
              <div className="flex h-[50vh] flex-col items-center justify-center gap-3 text-zinc-400">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-100">
                  <Terminal size={24} className="text-zinc-500" />
                </div>
                <p className="text-sm font-medium text-zinc-600">
                  Start a conversation to prepare or execute a Chaos Mesh experiment.
                </p>
                <p className="text-xs text-zinc-400">
                  Example: &apos;Prepare a network delay experiment in default namespace for app=nginx&apos;
                </p>
              </div>
            ) : (
              messages.map((message) => {
                const text = getMessageText(message);
                const toolDisplays = getToolDisplays(message);
                return (
                  <div
                    key={message.id}
                    className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-5 py-3.5 ${
                        message.role === "user"
                          ? "rounded-br-sm bg-zinc-900 text-white"
                          : "rounded-bl-sm border border-zinc-200 bg-zinc-50 text-zinc-800"
                      }`}
                    >
                      {!text &&
                        toolDisplays.length > 0 &&
                        !(
                          toolDisplays.length === 1 &&
                          toolDisplays[0]?.toolName === "ask_user_question"
                        ) && (
                        <div className="mb-2 text-[13px] leading-relaxed text-zinc-500">
                          {getToolNarrative(toolDisplays[toolDisplays.length - 1])}
                        </div>
                      )}
                      {text &&
                        (message.role === "assistant" ? (
                          <div className="text-[15px] leading-relaxed [&_a]:text-blue-600 [&_a]:underline [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 [&_code]:py-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_p]:last:mb-0 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-zinc-900 [&_pre]:p-3 [&_pre]:text-zinc-100 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                          </div>
                        ) : (
                          <div className="whitespace-pre-wrap text-[15px] leading-relaxed">{text}</div>
                        ))}
                      {!text && toolDisplays.length === 0 && (
                        <span className="italic text-zinc-400">No text response</span>
                      )}

                      {toolDisplays.length > 0 && (
                        <div className="mt-4">
                          {toolDisplays.map((tool) => {
                            const prepareResult =
                              tool.toolName === "chaos_prepare" &&
                              tool.state === "output-available" &&
                              typeof tool.output === "object" &&
                              tool.output !== null &&
                              "yamlContent" in tool.output
                                ? (tool.output as {
                                    directory?: string;
                                    message?: string;
                                    yamlContent?: string;
                                    scenario?: string;
                                    namespace?: string;
                                    duration?: string;
                                    labelSelectors?: Record<string, string>;
                                    podNames?: string[];
                                  })
                                : null;

                            return (
                              <div key={tool.key}>
                                <ToolInvocation
                                  tool={tool}
                                  onSelectQuestionOption={handleQuestionOptionSelect}
                                />
                                {prepareResult ? (
                                  <div className="mt-3">
                                    <ChaosPrepareCard result={prepareResult} />
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {isLoading && messages[messages.length - 1]?.role === "user" && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-zinc-200 bg-zinc-50 px-5 py-3.5 text-sm text-zinc-500">
                  <Loader2 size={16} className="animate-spin" />
                  {pendingProgressText || "正在分析请求并调用工具，请稍候..."}
                </div>
              </div>
            )}
            {chat.error && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-red-200 bg-red-50 px-5 py-3.5 text-sm text-red-700">
                  {chat.error.message}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-white via-white to-transparent p-4">
          <form onSubmit={(event) => void handleSubmit(event)} className="relative mx-auto max-w-5xl">
            <div className="relative flex items-center rounded-xl border border-zinc-200 bg-zinc-100 shadow-sm transition-all focus-within:bg-white focus-within:ring-2 focus-within:ring-zinc-900">
              <div className="relative flex items-center pl-3 pr-2">
                <button
                  type="button"
                  onClick={() => setIsDropdownOpen((value) => !value)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 whitespace-nowrap shadow-sm transition-colors hover:bg-zinc-50"
                >
                  <Settings size={14} /> {selectedCluster.name || "未选择集群"}{" "}
                  <ChevronDown size={14} className="text-zinc-400" />
                </button>

                {isDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsDropdownOpen(false)} />
                    <div className="absolute bottom-[calc(100%+8px)] left-3 z-50 w-56 rounded-lg border border-[#333] bg-[#252525] py-1.5 text-zinc-200 shadow-xl">
                      <div className="mb-1 flex items-center justify-between px-3 py-1.5 text-xs font-semibold text-zinc-400">
                        <span>选择集群</span>
                        <span className="text-[10px] font-normal text-zinc-500">({clusters.length})</span>
                      </div>
                      <div className="max-h-[30vh] overflow-y-auto">
                        {clusters.map((cluster) => (
                          <button
                            key={cluster.id}
                            type="button"
                            onClick={() => {
                              setSelectedClusterId(cluster.id);
                              setIsDropdownOpen(false);
                            }}
                            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-[#333]"
                          >
                            <span className="truncate">{cluster.name || "未命名集群"}</span>
                            {selectedCluster.id === cluster.id && (
                              <Check size={14} className="text-white" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
              <input
                ref={composerInputRef}
                className="w-full border-none bg-transparent py-3.5 pr-12 text-[15px] focus:ring-0 focus:outline-none"
                value={input}
                placeholder={inputPlaceholder}
                onChange={handleInputChange}
                disabled={isLoading || !isHistoryReady || !isClusterReady}
              />
              <button
                type="submit"
                disabled={isLoading || !isHistoryReady || !isClusterReady || !input.trim()}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg bg-zinc-900 p-2 text-white transition-colors hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-zinc-900"
              >
                <Send size={16} />
              </button>
            </div>
          </form>
          <div
            className={`mt-2 text-center text-[11px] ${
              historyDisabledReason || clusterSyncError ? "text-red-600" : "text-zinc-400"
            }`}
          >
            {historyDisabledReason
              ? `历史记录服务暂不可用：${historyDisabledReason}`
              : clusterSyncError
                ? `集群配置保存失败：${clusterSyncError}`
                : isHistorySaving
                  ? "Saving history..."
                  : isClusterSaving
                    ? "Saving cluster config..."
                    : "Chaos Agent can make mistakes. Verify configurations before applying."}
          </div>
        </div>
      </div>

      {isDeleteSessionModalOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={closeDeleteSessionModal} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-zinc-800">删除任务</h3>
                <button
                  type="button"
                  onClick={closeDeleteSessionModal}
                  disabled={isDeletingSession}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-3 px-4 py-4">
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  确认删除任务“{deleteSessionTitle || "未命名任务"}”？删除后不可恢复。
                </div>
                {deleteSessionError && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                    {deleteSessionError}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3">
                <button
                  type="button"
                  onClick={closeDeleteSessionModal}
                  disabled={isDeletingSession}
                  className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmDeleteSession()}
                  disabled={isDeletingSession}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {isDeletingSession ? "删除中..." : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {isRenameSessionModalOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={closeRenameSessionModal} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-zinc-800">重命名任务</h3>
                <button
                  type="button"
                  onClick={closeRenameSessionModal}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-3 px-4 py-4">
                <div>
                  <div className="mb-1 text-[10px] font-bold tracking-wider text-zinc-400 uppercase">
                    TITLE
                  </div>
                  <input
                    type="text"
                    value={renameSessionTitle}
                    onChange={(event) => setRenameSessionTitle(event.target.value)}
                    placeholder="请输入任务名称"
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </div>
                {renameSessionError && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                    {renameSessionError}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3">
                <button
                  type="button"
                  onClick={closeRenameSessionModal}
                  className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRenameSession()}
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {isClusterSettingsOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={closeClusterSettingsPanel} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-zinc-800">Chaos 对象集群配置</h3>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={openCreateClusterModalFromPanel}
                    className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                    title="新增集群配置"
                    aria-label="新增集群配置"
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={closeClusterSettingsPanel}
                    className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                    aria-label="关闭集群配置列表"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              <div className="max-h-[65vh] space-y-2 overflow-y-auto p-4">
                {clusters.map((cluster) => (
                  <div key={cluster.id} className="overflow-hidden rounded-md border border-zinc-200 bg-white">
                    <div className="px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-zinc-800">
                            {cluster.name || "未命名集群"}
                          </div>
                          <div
                            className="mt-1 truncate font-mono text-[11px] text-zinc-500"
                            title={cluster.endpoint}
                          >
                            Endpoint: {cluster.endpoint}
                          </div>
                          <div className="mt-1 text-[11px] text-zinc-500">
                            {cluster.token ? "Token: 已配置" : "Token: 未配置"}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {cluster.isDefault && (
                            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                              默认
                            </span>
                          )}
                          {selectedCluster.id === cluster.id && (
                            <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
                              当前使用
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-end border-t border-zinc-100 bg-zinc-50/70 p-1.5">
                      <button
                        type="button"
                        onClick={() => openEditClusterModalFromPanel(cluster)}
                        className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700"
                        title="编辑集群配置"
                        aria-label="编辑集群配置"
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  </div>
                ))}
                {clusters.length === 0 && (
                  <div className="py-4 text-center text-xs text-zinc-400">点击右上角 + 添加集群配置</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {isClusterModalOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={closeClusterModal} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-zinc-800">
                  {editingClusterId ? "编辑集群配置" : "新增集群配置"}
                </h3>
                <button
                  type="button"
                  onClick={closeClusterModal}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="space-y-3 px-4 py-4">
                <div>
                  <div className="mb-1 text-[10px] font-bold tracking-wider text-zinc-400 uppercase">
                    NAME
                  </div>
                  <input
                    type="text"
                    value={clusterFormName}
                    onChange={(event) => setClusterFormName(event.target.value)}
                    placeholder="e.g. my-cluster"
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-bold tracking-wider text-zinc-400 uppercase">
                    ENDPOINT
                  </div>
                  <input
                    type="text"
                    value={clusterFormEndpoint}
                    onChange={(event) => setClusterFormEndpoint(event.target.value)}
                    placeholder={CLUSTER_ENDPOINT_PLACEHOLDER}
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-bold tracking-wider text-zinc-400 uppercase">
                    TOKEN
                  </div>
                  <input
                    type="password"
                    value={clusterFormToken}
                    onChange={(event) => setClusterFormToken(event.target.value)}
                    placeholder="eyJh..."
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-zinc-600">
                  <input
                    type="checkbox"
                    checked={clusterFormIsDefault}
                    onChange={(event) => setClusterFormIsDefault(event.target.checked)}
                  />
                  设为默认集群
                </label>
                {clusterFormError && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                    {clusterFormError}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3">
                <button
                  type="button"
                  onClick={closeClusterModal}
                  className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSaveClusterModal}
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs text-white hover:bg-zinc-800"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
