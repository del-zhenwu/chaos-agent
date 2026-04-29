---
name: chaos-mesh-experiment-prepare
description: >
  Use when the user wants to prepare, create, or generate a Chaos Mesh
  experiment configuration. Covers PodChaos, NetworkChaos, StressChaos, etc.
---

# Chaos Mesh Experiment Prepare

Generate a Chaos Mesh experiment via tool-driven discovery and preparation.
Output must be a real manifest from the current cluster context, never mock data.

**Core principles:**
- Skill-driven orchestration (not API-route hardcoding)
- Real cluster discovery only (no fabricated targets)
- Scenario-agnostic workflow (pod/network/stress all supported)

## References

Always read:
- `references/output-format.md` — directory layout, slug naming, README template
- `references/chaos-base-template.md` — Chaos Mesh CRD skeleton

Read conditionally by scenario:
- `references/pod-chaos-guide.md` — PodChaos (pod-kill, pod-failure, container-kill)
- `references/network-chaos-guide.md` — NetworkChaos (delay, loss, duplicate, corrupt, partition, bandwidth)
- `references/stress-chaos-guide.md` — StressChaos (cpu, memory)

## Output Language Rule

Detect the user's conversation language and use the **same language** for all
output files (README.md, comments in YAML).
- Chinese input → Chinese output
- English input → English output
- Mixed → follow the dominant language

## Prerequisites

Required tools:
- `chaos_find_pods`
- `chaos_get_namespaces`
- `chaos_get_labels`
- `chaos_get_pods`
- `chaos_prepare`

## Workflow

### Step 1: Identify Scenario and Target

Classify intent from user request:
- Pod fault: pod-kill / pod-failure / container-kill
- Network fault: delay / loss / duplicate / corrupt / partition / bandwidth
- Resource stress: cpu / memory

If ambiguous, ask the user.

Collect missing parameters:
1. target namespace (or permission to auto-discover)
2. target selector (resource keyword, labels, or exact resource names)
3. duration (default `10m`)
4. scenario-specific options (latency/loss/cpu/memory size, etc.)

### Step 2: Discover Target Resources

Use a strict discovery chain. Do not stop after one failed call.

1. If user gives fuzzy target keyword, call the appropriate discovery tool first (`chaos_find_pods` for pod targets).
2. If no match, continue automatically:
   - call `chaos_get_namespaces`
   - call `chaos_get_labels` on candidate namespaces
   - call `chaos_get_pods` with promising label selectors
3. Build a ranked candidate list for the user:
   - include full resource identity from tool outputs (for pods: namespace + full pod name with suffix/hash)
   - explain what was searched
   - when multiple resource candidates exist, use `ask_user_question` options as:
     - one option per candidate resource
     - one explicit "Other/其它（手动输入）" option for custom target input
   - do not use "cancel" as the default fallback option during disambiguation
4. If still no valid target, ask for a narrower hint (namespace, label, or fuller keyword).

**Important:** Discovery must come from tool outputs only. Never synthesize pod names.

### Step 3: Generate Configuration Files

Call `chaos_prepare` with scenario-appropriate arguments:
- always pass `engine: "chaos-mesh"`
- Pod scenarios prefer exact `podNames` + `namespace` when available
- Network/stress scenarios can target via structured `labelSelectors` + `namespace`
- pass `duration` and scenario-specific config in `additionalConfig`

`chaos_prepare` must be treated as a verification gate:
- if target pod IDs/selector fail verification, stop and ask user to re-select targets
- only continue to confirmation when verification succeeded

### Step 4: Confirmation Gate

After `chaos_prepare` returns:
1. show the generated YAML content
2. summarize scenario, namespace, target, duration, and verified target identity
3. ask explicit user confirmation (question text should be concise; do not paste raw YAML into the question body)

Do not execute in this skill.

## Safety Rules

1. Never call `chaos_execute` in prepare flow.
2. Never assume pod-only targets; keep scenario handling dynamic.
3. Never use regex/sub-string hard rules as final target decision.
4. When intent is ambiguous or multiple candidates exist, call `ask_user_question`.
5. Clarification must prefer multiple-choice options over free-text whenever feasible.
6. Option labels must use full resource identity from tool outputs (for pod targets, use full pod names instead of deployment-style abbreviations).
7. For resource choices, include canonical machine-readable values in option value (e.g., `namespace/kind/name`; for pods, `namespace/podName`).
8. If a tool fails, explain real error and next recovery action.
9. For ambiguous target disambiguation, provide candidate options plus one "Other/其它（手动输入）" option so users can continue instead of terminating flow.
10. Always pass `engine: "chaos-mesh"` when calling chaos tools in this skill.
