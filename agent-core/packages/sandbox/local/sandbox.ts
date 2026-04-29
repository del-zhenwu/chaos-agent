import * as fs from "fs/promises";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import type { Dirent } from "fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SandboxType,
  SnapshotResult,
} from "../interface";
import type { LocalState } from "./state";

const execAsync = promisify(exec);

export class LocalSandbox implements Sandbox {
  readonly type: SandboxType = "cloud"; // Keep "cloud" to satisfy the interface
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly currentBranch?: string;
  readonly hooks?: SandboxHooks;
  readonly environmentDetails?: string;

  constructor(
    workingDirectory: string,
    env?: Record<string, string>,
    currentBranch?: string,
    hooks?: SandboxHooks
  ) {
    this.workingDirectory = workingDirectory;
    this.env = env;
    this.currentBranch = currentBranch;
    this.hooks = hooks;
    this.environmentDetails = "Local Node.js Sandbox";
  }

  async readFile(filePath: string, encoding: "utf-8"): Promise<string> {
    return fs.readFile(filePath, encoding);
  }

  async writeFile(filePath: string, content: string, encoding: "utf-8"): Promise<void> {
    await fs.writeFile(filePath, content, encoding);
  }

  async stat(filePath: string): Promise<SandboxStats> {
    const stats = await fs.stat(filePath);
    return {
      isDirectory: () => stats.isDirectory(),
      isFile: () => stats.isFile(),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  async access(filePath: string): Promise<void> {
    await fs.access(filePath);
  }

  async mkdir(filePath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(filePath, options);
  }

  async readdir(filePath: string, options: { withFileTypes: true }): Promise<Dirent[]> {
    return fs.readdir(filePath, options);
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal }
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env: { ...process.env, ...this.env },
        timeout: timeoutMs,
        signal: options?.signal,
      });
      return {
        success: true,
        exitCode: 0,
        stdout,
        stderr,
        truncated: false,
      };
    } catch (error: any) {
      return {
        success: false,
        exitCode: error.code ?? 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
        truncated: false,
      };
    }
  }

  async execDetached(command: string, cwd: string): Promise<{ commandId: string }> {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...this.env },
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { commandId: String(child.pid) };
  }

  async stop(): Promise<void> {
    if (this.hooks?.beforeStop) {
      await this.hooks.beforeStop(this);
    }
  }

  getState(): { type: "local" } & LocalState {
    return {
      type: "local",
      workingDirectory: this.workingDirectory,
    };
  }
}
