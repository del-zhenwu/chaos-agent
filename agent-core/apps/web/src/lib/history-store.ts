import { randomUUID } from "crypto";
import type { UIMessage } from "ai";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma";

export type HistorySession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ClusterConfig = {
  id: string;
  name: string;
  endpoint: string;
  token: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

type SaveClusterInput = {
  id?: string;
  name: string;
  endpoint: string;
  token: string;
  isDefault?: boolean;
};

const uuidSchema = z.string().uuid();

function normalizeClusterId(id: unknown): string | undefined {
  if (typeof id !== "string") {
    return undefined;
  }
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return uuidSchema.safeParse(trimmed).success ? trimmed : undefined;
}

function toHistorySession(row: {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}): HistorySession {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toClusterConfig(row: {
  id: string;
  name: string;
  endpoint: string;
  token: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ClusterConfig {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    token: row.token,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPrismaJson(value: UIMessage): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

async function ensureDefaultCluster(): Promise<void> {
  const count = await prisma.clusterConfig.count();
  if (count > 0) {
    return;
  }

  await prisma.clusterConfig.create({
    data: {
      id: randomUUID(),
      name: resolveSeedClusterName(),
      endpoint: resolveSeedClusterEndpoint(),
      token: process.env.CHAOS_TOKEN ?? "",
      isDefault: true,
    },
  });
}

function resolveSeedClusterName(): string {
  return process.env.CHAOS_CLUSTER_NAME?.trim() || "";
}

function resolveSeedClusterEndpoint(): string {
  return process.env.CHAOS_DASHBOARD_URL?.trim() || "";
}

function normalizeClusterEndpoint(endpoint: unknown): string {
  return typeof endpoint === "string" ? endpoint.trim() : "";
}

function normalizeClusters(input: SaveClusterInput[]): SaveClusterInput[] {
  const sanitized = input
    .map((cluster) => ({
      id: normalizeClusterId(cluster.id),
      name: cluster.name.trim(),
      endpoint: normalizeClusterEndpoint(cluster.endpoint),
      token: cluster.token.trim(),
      isDefault: cluster.isDefault === true,
    }))
    .filter((cluster) => cluster.name.length > 0);

  if (sanitized.length === 0) {
    return [
      {
        name: resolveSeedClusterName(),
        endpoint: resolveSeedClusterEndpoint(),
        token: "",
        isDefault: true,
      },
    ];
  }

  const hasDefault = sanitized.some((cluster) => cluster.isDefault);
  if (!hasDefault) {
    sanitized[0].isDefault = true;
    return sanitized;
  }

  let firstDefaultFound = false;
  return sanitized.map((cluster) => {
    if (!cluster.isDefault) {
      return cluster;
    }
    if (!firstDefaultFound) {
      firstDefaultFound = true;
      return cluster;
    }
    return { ...cluster, isDefault: false };
  });
}

export async function listHistorySessions(): Promise<HistorySession[]> {
  const rows = await prisma.chatSession.findMany({
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return rows.map(toHistorySession);
}

export async function createHistorySession(title?: string): Promise<HistorySession> {
  const row = await prisma.chatSession.create({
    data: {
      id: randomUUID(),
      title: title?.trim() || "新建任务",
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return toHistorySession(row);
}

export async function renameHistorySession(
  sessionId: string,
  title: string,
): Promise<HistorySession | null> {
  const normalizedTitle = title.trim() || "新建任务";
  const row = await prisma.chatSession.updateMany({
    where: { id: sessionId },
    data: { title: normalizedTitle },
  });
  if (row.count === 0) {
    return null;
  }
  const updated = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return updated ? toHistorySession(updated) : null;
}

export async function deleteHistorySession(sessionId: string): Promise<boolean> {
  const result = await prisma.chatSession.deleteMany({
    where: { id: sessionId },
  });
  return result.count > 0;
}

export async function getHistoryMessages(sessionId: string): Promise<UIMessage[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { position: "asc" },
    select: { message: true },
  });

  return rows.map((row) => row.message as unknown as UIMessage);
}

export async function saveHistoryMessages(
  sessionId: string,
  title: string,
  messages: UIMessage[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.chatSession.upsert({
      where: { id: sessionId },
      create: { id: sessionId, title: title.trim() || "新建任务" },
      update: { title: title.trim() || "新建任务" },
    });

    await tx.chatMessage.deleteMany({ where: { sessionId } });

    if (messages.length > 0) {
      await tx.chatMessage.createMany({
        data: messages.map((message, position) => ({
          id: typeof message.id === "string" && message.id.length > 0 ? message.id : randomUUID(),
          sessionId,
          position,
          role: message.role,
          message: toPrismaJson(message),
        })),
      });
    }
  });
}

export async function listClusterConfigs(): Promise<ClusterConfig[]> {
  await ensureDefaultCluster();

  const rows = await prisma.clusterConfig.findMany({
    select: {
      id: true,
      name: true,
      endpoint: true,
      token: true,
      isDefault: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { name: "asc" }],
  });

  return rows.map(toClusterConfig);
}

export async function saveClusterConfigs(clusters: SaveClusterInput[]): Promise<ClusterConfig[]> {
  const normalized = normalizeClusters(clusters);

  await prisma.$transaction(async (tx) => {
    await tx.clusterConfig.deleteMany({});
    await tx.clusterConfig.createMany({
      data: normalized.map((cluster) => ({
        id: cluster.id ?? randomUUID(),
        name: cluster.name,
        endpoint: cluster.endpoint,
        token: cluster.token,
        isDefault: cluster.isDefault === true,
      })),
    });
  });

  return listClusterConfigs();
}

export async function getClusterTokenByName(clusterName: string): Promise<string | undefined> {
  const cluster = await getClusterConfigByName(clusterName);
  return cluster.token;
}

export async function getClusterConfigByName(clusterName: string): Promise<{
  name: string;
  token?: string;
  endpoint: string;
}> {
  await ensureDefaultCluster();
  const normalized = clusterName.trim();
  if (normalized) {
    const direct = await prisma.clusterConfig.findUnique({
      where: { name: normalized },
      select: { name: true, token: true, endpoint: true },
    });
    if (direct) {
      const directToken = direct.token?.trim();
      return {
        name: direct.name,
        token: directToken || undefined,
        endpoint: normalizeClusterEndpoint(direct.endpoint),
      };
    }
  }

  const fallback = await prisma.clusterConfig.findFirst({
    where: { isDefault: true },
    orderBy: { updatedAt: "desc" },
    select: { name: true, token: true, endpoint: true },
  });
  const fallbackToken = fallback?.token?.trim();
  const resolvedName = fallback?.name ?? (normalized || resolveSeedClusterName());
  return {
    name: resolvedName,
    token: fallbackToken || undefined,
    endpoint: normalizeClusterEndpoint(fallback?.endpoint) || resolveSeedClusterEndpoint(),
  };
}

export async function upsertClusterToken(clusterName: string, token: string): Promise<void> {
  const normalizedName = clusterName.trim();
  const normalizedToken = token.trim();
  if (!normalizedName || !normalizedToken) {
    return;
  }

  await ensureDefaultCluster();
  const count = await prisma.clusterConfig.count();

  await prisma.clusterConfig.upsert({
    where: { name: normalizedName },
    create: {
      id: randomUUID(),
      name: normalizedName,
      endpoint: resolveSeedClusterEndpoint(),
      token: normalizedToken,
      isDefault: count === 0,
    },
    update: {
      token: normalizedToken,
    },
  });
}
