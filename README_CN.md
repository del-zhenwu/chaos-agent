[English](README.md) | [中文](README_CN.md)

# Chaos Agent

一个基于 `vercel-labs/open-agents` 的本地对话式混沌工程 Agent，面向 Kubernetes 场景。

## 项目能力

- 提供聊天优先的交互体验，覆盖实验准备到执行的完整流程。
- 通过统一工作流支持多混沌引擎。
- 集群配置与聊天记录落库到本地 PostgreSQL。
- 混沌执行基于集群 API 访问（`endpoint + token`），不依赖本地 `kubectl` 执行链路。

## 支持的 Chaos 引擎

- **Chaos Mesh**：兼容 **Chaos Mesh v2.6.x - v2.8.x**（`chaos-mesh.org/v1alpha1`）
- **ChaosBlade（Kubernetes）**：兼容 **chaosblade-operator v1.7.x - v1.8.x**（`chaosblade.io/v1alpha1`）

## 仓库结构

- `agent-core/`：核心应用与 Agent 运行时（Next.js + tools + Prisma）
- `skills/`：Chaos 相关技能目录
  - `chaos-mesh-experiment-prepare`
  - `chaos-mesh-experiment-execute`
  - `chaosblade-experiment-prepare`
  - `chaosblade-experiment-execute`
- `CHAOS_MESH_AGENT_GUIDE.md`：补充说明与实践指南

## 快速开始

1. 在 `agent-core/apps/web/.env.local`（或根目录 `.env.local`）配置：
   - `LLM_API_KEY`
   - `LLM_API_URL`
   - `LLM_MODEL`
   - `LOCAL_DATABASE_URL`
2. 在仓库根目录安装依赖：

```bash
bun install
```

3. 同步 Prisma：

```bash
cd agent-core/apps/web
bun run prisma:generate
bun run prisma:push
```

4. 启动 Web：

```bash
cd agent-core/apps/web
bun run dev
```

5. 打开 `http://localhost:3000`，在 UI 中配置集群：
   - `name`
   - `endpoint`
   - `token`

## 运行时配置说明

- `CHAOS_ENGINE` 可选 `chaos-mesh` / `chaosblade-k8s`。
- 实际生效的 `endpoint` 与 `token` 按所选 `clusterName` 从数据库读取。
- 若未配置 endpoint，Chaos Mesh 工具调用会快速失败并返回明确提示。

## 当前行为约束

- 准备/执行流程默认仅保留单次执行确认门。
- 助手文本支持 Markdown 渲染。
- 工具调用含进行中状态与执行状态展示。
- 目标歧义场景使用结构化选项，并提供“手动输入”分支。

## 参考项目

- 核心框架：[vercel-labs/open-agents](https://github.com/vercel-labs/open-agents)
- Chaos Mesh：[chaos-mesh/chaos-mesh](https://github.com/chaos-mesh/chaos-mesh)
- ChaosBlade Operator：[chaosblade-io/chaosblade-operator](https://github.com/chaosblade-io/chaosblade-operator)

