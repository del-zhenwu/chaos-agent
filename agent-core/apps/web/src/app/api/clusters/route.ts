import { NextResponse } from "next/server";
import { z } from "zod";
import { listClusterConfigs, saveClusterConfigs } from "@/lib/history-store";

export const runtime = "nodejs";

const clusterInputSchema = z.object({
  // Accept legacy/non-UUID ids from older clients; normalize in history-store.
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  endpoint: z.string().trim().min(1).max(500),
  token: z.string(),
  isDefault: z.boolean().optional(),
});

const saveClustersSchema = z.object({
  clusters: z.array(clusterInputSchema),
});

export async function GET() {
  try {
    const clusters = await listClusterConfigs();
    return NextResponse.json({ clusters });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load clusters." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const parsed = saveClustersSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
        { status: 400 },
      );
    }

    const clusters = await saveClusterConfigs(parsed.data.clusters);
    return NextResponse.json({ clusters });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save clusters." },
      { status: 500 },
    );
  }
}
