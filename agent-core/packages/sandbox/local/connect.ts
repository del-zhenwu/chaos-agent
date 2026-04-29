import { LocalSandbox } from "./sandbox";
import type { LocalState } from "./state";
import type { ConnectOptions } from "../factory";

export async function connectLocal(
  state: LocalState,
  options?: ConnectOptions
): Promise<LocalSandbox> {
  return new LocalSandbox(
    state.workingDirectory,
    options?.env,
    options?.gitUser?.name, // Use gitUser name as currentBranch for now (hacky)
    options?.hooks
  );
}
