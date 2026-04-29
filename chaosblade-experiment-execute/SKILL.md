---
name: chaosblade-experiment-execute
description: >
  Use when the user wants to execute a prepared ChaosBlade (k8s) experiment
  after explicit confirmation.
---

# ChaosBlade Experiment Execute

Execute a previously prepared ChaosBlade experiment through the execution tool.
Never auto-start; require explicit user confirmation first.

## Output Language Rule

Detect user language and use the same language for output.

## Prerequisites

Required tools:
- `chaos_execute`

## Workflow

### Step 1: Validate Intent

Confirm the user explicitly wants to start now.
If user is still reviewing YAML, do not execute yet.
If the user just confirmed from the prepare-step confirmation options, treat that as approved and execute directly without asking again.

### Step 2: Safety Confirmation

Before execution, summarize:
1. engine (`chaosblade-k8s`)
2. scenario
3. target namespace/selector/pod names
4. expected duration

### Step 3: Execute

Call `chaos_execute` with:
- prepared directory
- `engine: "chaosblade-k8s"`

Return real execution status from tool output.

### Step 4: Report

Summarize:
1. success/failure
2. current/final status and elapsed time
3. key output details
4. next action (observe/retry/rollback)

## Safety Rules

1. Never execute without explicit user confirmation.
2. Always pass `engine: "chaosblade-k8s"` in this skill.
3. Never fabricate execution output.
4. If tool returns `success: false`, explain error and recovery options.
5. Single confirmation gate: do not ask a second confirmation if prepare flow already completed confirmation.
