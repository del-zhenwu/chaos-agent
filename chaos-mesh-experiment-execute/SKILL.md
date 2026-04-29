---
name: chaos-mesh-experiment-execute
description: >
  Use when the user wants to execute a prepared Chaos Mesh experiment after
  explicit confirmation.
---

# Chaos Mesh Experiment Execute

Execute a previously prepared Chaos Mesh experiment using execution tools.
Do not auto-start. Always require explicit user confirmation first.

## Output Language Rule

Detect the language of the user's conversation and use the **same language** for all output.
- Chinese input -> Chinese output
- English input -> English output

## Prerequisites

Required tools:
- `chaos_execute`

## Workflow

### Step 1: Validate Execution Intent

Confirm user explicitly wants to start now (not just preview YAML).
If user has not approved yet, ask for approval first.
If the user just confirmed from the prepare-step confirmation options, treat that as approved and execute directly without asking again.

### Step 2: Safety Confirmation

Before execution, clearly show impact summary:
1. scenario
2. namespace / selectors / pod names
3. expected duration
4. rollback/stop hint if available

### Step 3: Execute

Call `chaos_execute` with the prepared experiment directory and `engine: "chaos-mesh"`.
Return real stdout/stderr and execution status to the user.

### Step 4: Report

Summarize:
1. execution success/failure
2. current/final experiment status (injecting/running/finished/failed) and elapsed time
3. command output highlights
4. next action (observe/rollback/retry)

## Safety Rules

1. **Never auto-start experiments.** Always require explicit user confirmation.
2. **Use real tool output only.** Do not fabricate execution results.
3. **Display impact warning** before experiment start.
4. **Provide abort instructions** at every step.
5. **Always pass engine**: use `engine: "chaos-mesh"` in this skill.
6. **Single confirmation gate**: do not ask a second confirmation if prepare flow already completed confirmation.
