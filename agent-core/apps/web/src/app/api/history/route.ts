import type { UIMessage } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createHistorySession,
  deleteHistorySession,
  getHistoryMessages,
  listHistorySessions,
  renameHistorySession,
  saveHistoryMessages,
} from "@/lib/history-store";

export const runtime = "nodejs";

const sessionIdSchema = z.string().uuid();

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
});

const saveMessagesSchema = z.object({
  sessionId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  messages: z.array(z.custom<UIMessage>()),
});

const renameSessionSchema = z.object({
  sessionId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");

    if (sessionId) {
      const parsedSessionId = sessionIdSchema.safeParse(sessionId);
      if (!parsedSessionId.success) {
        return NextResponse.json(
          { error: "Invalid sessionId." },
          { status: 400 },
        );
      }

      const messages = await getHistoryMessages(parsedSessionId.data);
      return NextResponse.json({ sessionId: parsedSessionId.data, messages });
    }

    const sessions = await listHistorySessions();
    return NextResponse.json({ sessions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read history." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
        { status: 400 },
      );
    }

    const session = await createHistorySession(parsed.data.title);
    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create session." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const parsed = saveMessagesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
        { status: 400 },
      );
    }

    await saveHistoryMessages(parsed.data.sessionId, parsed.data.title, parsed.data.messages);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save history." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const parsed = renameSessionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
        { status: 400 },
      );
    }

    const session = await renameHistorySession(parsed.data.sessionId, parsed.data.title);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to rename session." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");
    const parsedSessionId = sessionIdSchema.safeParse(sessionId);
    if (!parsedSessionId.success) {
      return NextResponse.json(
        { error: "Invalid sessionId." },
        { status: 400 },
      );
    }
    const deleted = await deleteHistorySession(parsedSessionId.data);
    if (!deleted) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete session." },
      { status: 500 },
    );
  }
}
