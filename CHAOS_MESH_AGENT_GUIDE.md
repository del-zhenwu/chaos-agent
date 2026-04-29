# 构建基于 Chaos Mesh 的对话式 Chaos 测试 Agent

本文档介绍了如何参考 [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) 构建一个通过对话即可完成 Chaos Mesh 混沌测试的 Agent。我们参考了当前仓库中的 AWS FIS 方案，并将其适配到 Chaos Mesh 平台。

## 架构概览

参考 `open-agents` 的三层架构，我们的 Chaos Mesh Agent 包含以下部分：

1. **Web UI**: 提供用户对话界面（基于 Next.js 和 Vercel AI SDK）。
2. **Agent Workflow**: 负责解析用户意图，调用对应的 Agent Skills。
3. **Sandbox VM**: 运行 `kubectl` 并连接到用户已部署好 Chaos Mesh 的 Kubernetes 集群。

## Agent Skills (核心能力)

我们已经在此仓库中创建了两个核心的 Agent Skills，它们遵循 `open-agents` 的 `.agents/skills` 规范：

1. **`chaos-mesh-experiment-prepare`**: 
   - 负责与用户对话，收集混沌实验的需求（如：目标 Namespace、Pod 标签、故障类型、持续时间等）。
   - 自动生成符合 Chaos Mesh CRD 规范的 `chaos-experiment.yaml`。
   - 提供实验的预检和确认。

2. **`chaos-mesh-experiment-execute`**:
   - 负责执行已准备好的混沌实验。
   - 在执行前检查目标 Pod 的健康状态。
   - 通过 `kubectl apply` 注入故障，并实时监控实验状态。
   - 实验结束后，自动清理故障（`kubectl delete`）并生成实验结果报告 `results.md`。

## 如何在 Open Agents 中集成

1. **克隆并部署 Open Agents**:
   ```bash
   git clone https://github.com/vercel-labs/open-agents.git
   cd open-agents
   ```

2. **导入 Chaos Mesh Skills**:
   将本仓库 `skills/` 目录中的 `chaos-mesh-experiment-prepare` 和 `chaos-mesh-experiment-execute` 复制到 `open-agents` 的 `.agents/skills/` 目录下。

   ```bash
   cp -r /path/to/chaos-agent/skills/chaos-mesh-experiment-prepare .agents/skills/
   cp -r /path/to/chaos-agent/skills/chaos-mesh-experiment-execute .agents/skills/
   ```

3. **配置 Sandbox 环境**:
   由于 Chaos Mesh 需要与 Kubernetes 集群交互，你需要确保 `open-agents` 的 Sandbox VM 中安装了 `kubectl`，并且配置了正确的 `kubeconfig` 以访问目标集群。

   在 `open-agents` 的启动脚本或 Sandbox 初始化配置中添加：
   ```bash
   # 安装 kubectl
   curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
   chmod +x kubectl
   mv kubectl /usr/local/bin/

   # 配置 kubeconfig (通过环境变量或挂载 Secret 注入)
   mkdir -p ~/.kube
   echo "$KUBECONFIG_CONTENT" > ~/.kube/config
   ```

4. **对话示例**:
   在 Web UI 中，你可以这样与 Agent 对话：
   
   **User**: "帮我准备一个 Chaos Mesh 实验，目标是 default 命名空间下 app=nginx 的 Pod，注入 5 分钟的网络延迟（100ms）。"
   
   **Agent**: (调用 `chaos-mesh-experiment-prepare` skill)
   "好的，我为您生成了网络延迟实验的配置。目录已创建，包含 `chaos-experiment.yaml`。目标 Pod 目前有 3 个，状态正常。是否需要现在执行？"

   **User**: "执行实验。"

   **Agent**: (调用 `chaos-mesh-experiment-execute` skill)
   "正在执行实验... 已应用 `chaos-experiment.yaml`。目前实验状态：Injecting。
   ...
   实验已完成，网络延迟已恢复。这是您的实验报告 `results.md`。"

## 扩展能力

您可以根据需要继续扩展 Agent 的能力：
- **日志分析**: 集成类似 `app-service-log-analysis` 的能力，在故障注入期间收集 Pod 日志，分析报错率。
- **指标监控**: 对接 Prometheus 或 Grafana，在对话中展示故障注入期间的 QPS 和 Latency 变化。
- **更多故障类型**: 在 `prepare` skill 中增加对 HTTPChaos、DNSChaos、JVMChaos 等更复杂故障类型的支持。
