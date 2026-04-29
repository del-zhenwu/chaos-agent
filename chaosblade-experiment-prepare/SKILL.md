---
name: chaosblade-experiment-prepare
description: >
  Use when the user wants to prepare, create, or generate a ChaosBlade (k8s)
  experiment configuration.
---

# ChaosBlade Experiment Prepare

Generate a ChaosBlade experiment via tool-driven discovery and preparation.
Output must be based on real API data from the current cluster context.

## Output Language Rule

Detect the user's conversation language and use the same language for output.

## Prerequisites

Required tools:
- `chaos_find_pods`
- `chaos_get_namespaces`
- `chaos_get_labels`
- `chaos_get_pods`
- `chaos_prepare`

## Workflow

### Step 1: Identify Scenario and Target

Classify user intent into scenario:
- `pod-kill`
- `pod-failure`
- `network-delay`
- `network-loss`
- `cpu-stress`
- `memory-stress`

Collect required fields:
1. namespace
2. target selector (exact pod names or structured labels)
3. duration
4. scenario config (latency/loss/cpuPercent/memPercent)

### Step 2: Discover Target Resources

Use strict discovery chain and do not stop early:
1. `chaos_find_pods` with `engine: "chaosblade-k8s"`
2. if unclear, continue with `chaos_get_namespaces` + `chaos_get_labels` + `chaos_get_pods` (all with `engine: "chaosblade-k8s"`)
3. when multiple candidates exist, ask user to choose via `ask_user_question`:
   - include each candidate as one option
   - include one "Other/其它（手动输入）" option
   - do not use "cancel" as default fallback

### Step 3: Generate Config

Call `chaos_prepare` with:
- `engine: "chaosblade-k8s"`
- scenario
- namespace
- exact `podNames` or structured `labelSelectors`
- duration
- `additionalConfig` when needed

Treat `chaos_prepare` as verification gate:
- if verification fails, stop and ask user to refine target
- only continue after success

### Step 4: Confirmation Gate

After `chaos_prepare` succeeds:
1. show generated YAML
2. summarize engine, scenario, namespace, target, duration
3. ask explicit confirmation with concise text (do not inline raw YAML into confirmation question body)

Do not execute in this skill.

## Safety Rules

1. Never call `chaos_execute` in prepare flow.
2. Always pass `engine: "chaosblade-k8s"` to chaos tools in this skill.
3. Never fabricate targets, labels, namespaces, YAML, or status.
4. When intent is ambiguous, prefer multiple-choice clarifications.
5. If a tool fails, explain real error and next recovery action.
