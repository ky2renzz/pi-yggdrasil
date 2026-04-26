import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readFileSync, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute, sep } from "node:path";

const WORKSPACE_FILE = "pi-workspace.json";

type Repo = { name: string; path: string; description?: string };
type Workspace = { name: string; repos: Repo[] };

function getRoot(cwd: string): string {
  if (process.platform === "win32") {
    const match = cwd.match(/^([A-Z]:)/i);
    return match ? match[1] + sep : "C:" + sep;
  }
  return "/";
}

export default function (pi: ExtensionAPI) {
  let workspace: Workspace | null = null;
  let activeRepo: string | null = null;

  function findWorkspaceFile(startDir: string): string | null {
    let current = startDir;
    const root = getRoot(startDir);
    while (current !== root) {
      const candidate = join(current, WORKSPACE_FILE);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  pi.on("session_start", async (_event, ctx) => {
    workspace = loadWorkspace(ctx);
    activeRepo = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "workspace" || entry.message.toolName === "repo") {
          activeRepo = entry.message.details?.activeRepo ?? activeRepo;
        }
      }
    }
  });

  function loadWorkspace(ctx: ExtensionContext): Workspace | null {
    const wsPath = findWorkspaceFile(ctx.cwd);
    if (!wsPath) return null;
    try {
      const data = JSON.parse(readFileSync(wsPath, "utf-8"));
      if (!data?.name || !Array.isArray(data.repos)) throw new Error("Invalid workspace structure");
      return data as Workspace;
    } catch (err) {
      throw new Error(`Invalid workspace file: ${(err as Error).message}`);
    }
  }

  function getWorkspace(ctx: ExtensionContext): Workspace {
    if (!workspace) {
      workspace = loadWorkspace(ctx);
      if (!workspace) throw new Error("No workspace found. Create pi-workspace.json first.");
    }
    return workspace;
  }

  async function listDir(dir: string, prefix: string, depth: number): Promise<string> {
    if (depth <= 0) return "";
    try {
      const entries = await readdir(dir);
      const lines: string[] = [];
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const fullPath = join(dir, entry);
        const isDir = (await stat(fullPath)).isDirectory();
        lines.push(`${prefix}${entry}${isDir ? "/" : ""}`);
        if (isDir) {
          const subdir = await listDir(fullPath, prefix + "  ", depth - 1);
          if (subdir) lines.push(subdir);
        }
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  pi.registerTool({
    name: "workspace",
    label: "Workspace",
    description: "Manage multi-repo workspace. List repos, switch active repo, show workspace info.",
    promptSnippet: "List repos, switch active repo, or show workspace info",
    promptGuidelines: [
      "Use workspace tool with action=list when user asks about repos",
      "Use workspace tool with action=switch when user wants to change repo",
      "Use workspace tool with action=info for workspace overview"
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "switch", "info"] as const),
      repo: Type.Optional(Type.String({ description: "Repo name (for switch action)" })),
    }),
    prepareArguments(args: unknown): { repo?: string; action: "list" | "switch" | "info" } {
      if (!args || typeof args !== "object") return args as { repo?: string; action: "list" | "switch" | "info" };
      const input = args as { action?: string; oldAction?: string };
      if (typeof input.oldAction === "string" && input.action === undefined) {
        return { ...input, action: input.oldAction } as { repo?: string; action: "list" | "switch" | "info" };
      }
      return args as { repo?: string; action: "list" | "switch" | "info" };
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: { activeRepo } };
      }
      const ws = getWorkspace(ctx);

      if (params.action === "list") {
        const list = ws.repos.map((r) => {
          const isActive = r.name === activeRepo;
          return `- ${r.name}: ${r.path}${isActive ? " [ACTIVE]" : ""}${r.description ? ` (${r.description})` : ""}`;
        }).join("\n");
        ctx.ui.setStatus("pi-multi-repo", `${ws.name}: ${activeRepo || "no active repo"}`);
        return {
          content: [{ type: "text", text: `Workspace: ${ws.name}\n\nRepos:\n${list}` }],
          details: { activeRepo },
        };
      }

      if (params.action === "switch") {
        if (!params.repo) throw new Error("repo parameter required for switch");
        const repo = ws.repos.find((r) => r.name === params.repo);
        if (!repo) throw new Error(`Repo "${params.repo}" not found`);
        activeRepo = repo.name;
        ctx.ui.setStatus("pi-multi-repo", `Active: ${repo.name}`);
        ctx.ui.notify(`Switched to repo: ${repo.name}`, "info");
        return {
          content: [{ type: "text", text: `Switched to repo: ${repo.name} (${repo.path})` }],
          details: { activeRepo },
          terminate: true,
        };
      }

      if (params.action === "info") {
        ctx.ui.setStatus("pi-multi-repo", `${ws.name}: ${activeRepo || "none"}`);
        return {
          content: [{ type: "text", text: `Workspace: ${ws.name}\nActive repo: ${activeRepo || "none"}\nTotal repos: ${ws.repos.length}` }],
          details: { activeRepo },
        };
      }

      throw new Error(`Unknown action: ${params.action}`);
    },
  });

  pi.registerTool({
    name: "repo",
    label: "Repo",
    description: "Quick repo operations: cd to repo, get repo path, list repo files.",
    promptSnippet: "Navigate to repo, get path, or list files",
    promptGuidelines: [
      "Use repo tool with action=path when you need absolute path",
      "Use repo tool with action=cd for cd command suggestions",
      "Use repo tool with action=ls to list files"
    ],
    parameters: Type.Object({
      action: StringEnum(["cd", "path", "ls"] as const),
      repo: Type.Optional(Type.String({ description: "Repo name" })),
    }),
    prepareArguments(args: unknown): { repo?: string; action: "cd" | "path" | "ls" } {
      if (!args || typeof args !== "object") return args as { repo?: string; action: "cd" | "path" | "ls" };
      const input = args as { action?: string; oldAction?: string };
      if (typeof input.oldAction === "string" && input.action === undefined) {
        return { ...input, action: input.oldAction } as { repo?: string; action: "cd" | "path" | "ls" };
      }
      return args as { repo?: string; action: "cd" | "path" | "ls" };
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: {} };
      }
      const ws = getWorkspace(ctx);
      const repoName = params.repo || activeRepo;
      if (!repoName) throw new Error("No active repo. Use the workspace tool with action=switch first.");
      const repo = ws.repos.find((r) => r.name === repoName);
      if (!repo) throw new Error(`Repo "${repoName}" not found`);
      // Strip leading @ that some models add to paths (per Pi docs)
      const cleanPath = repo.path.replace(/^@/, "");
      const repoPath = isAbsolute(cleanPath) ? cleanPath : resolve(ctx.cwd, cleanPath);

      if (params.action === "path") {
        ctx.ui.setStatus("pi-multi-repo", `Path: ${repo.name}`);
        return {
          content: [{ type: "text", text: repoPath }],
          details: {},
        };
      }

      const escapedPath = /[\s()]/.test(repoPath) ? `"${repoPath}"` : repoPath;

      if (params.action === "cd") {
        ctx.ui.setStatus("pi-multi-repo", `cd ${repo.name}`);
        return {
          content: [{ type: "text", text: `cd ${escapedPath}` }],
          details: {},
        };
      }

      if (params.action === "ls") {
        try {
          const files = await listDir(repoPath, "", 3);
          ctx.ui.setStatus("pi-multi-repo", `Listed: ${repo.name}`);
          return {
            content: [{ type: "text", text: files || "(empty directory)" }],
            details: {},
          };
        } catch (err) {
          throw new Error(`Cannot list files in "${repo.name}": ${(err as Error).message}`);
        }
      }

      throw new Error(`Unknown action: ${params.action}`);
    },
  });


  pi.registerCommand("workspace", {
    description: "Show workspace info",
    handler: async (_args, ctx) => {
      const ws = loadWorkspace(ctx);
      if (!ws) {
        ctx.ui.notify("No workspace found. Create pi-workspace.json", "warning");
        return;
      }
      ctx.ui.notify(`Workspace: ${ws.name} (${ws.repos.length} repos)`, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const ws = workspace ?? loadWorkspace(ctx);
    if (!ws) return;
    const repoInfo = ws.repos.map(r => {
      const isActive = r.name === activeRepo;
      return `- ${r.name}${isActive ? " [ACTIVE]" : ""}: ${r.path}${r.description ? ` (${r.description})` : ""}`;
    }).join("\n");
    return {
      systemPrompt: event.systemPrompt + `\n\n--- Workspace Context ---\nWorkspace: ${ws.name}\nActive repo: ${activeRepo || "none"}\nAvailable repos:\n${repoInfo}\n-------------------------\n`,
    };
  });

  pi.on("session_shutdown", async () => {
    workspace = null;
    activeRepo = null;
  });
}
