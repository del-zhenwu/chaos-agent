# agent-core

This directory contains the core web application and agent runtime for **Chaos Agent**, built on top of the open-source `vercel-labs/open-agents` reference app.

It handles:
- The Next.js web application (UI, Chat interface, configuration management).
- The Agent workflow and tool definitions (interacting with Chaos Mesh and ChaosBlade APIs).
- Local database integration via Prisma (storing chat history and cluster configurations).

## Development

1. Set up the environment variables in `apps/web/.env.local`.
2. Install dependencies:
   ```bash
   bun install
   ```
3. Initialize the database:
   ```bash
   cd apps/web
   bun run prisma:generate
   bun run prisma:push
   ```
4. Start the development server:
   ```bash
   cd apps/web
   bun run dev
   ```

## Repository Layout

- `apps/web`: Next.js app, API routes, chat UI, Prisma schema.
- `packages/agent`: Agent implementation, core prompt definitions, chaos engineering tools.
- `packages/sandbox`: Sandbox abstraction (derived from open-agents).
- `packages/shared`: Shared utilities.
- `scripts`: Utility scripts.

## Acknowledgements

The core architecture is heavily derived from [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents).