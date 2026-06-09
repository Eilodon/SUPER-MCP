import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "../config/env.js";
import type { ToolDefinition } from "./registrar.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAFE_BASENAME = /^[a-zA-Z0-9_.-]+\.tool\.(js|ts)$/;
let loadedPluginManifestHash: string | null = null;

function parseList(raw: string): string[] {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function parseHashAllowlist(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of parseList(raw)) {
    const [file, hash] = entry.split(":");
    if (file && hash) map.set(file, hash.toLowerCase());
  }
  return map;
}

function blockedBySafeMode(tool: ToolDefinition<any>): boolean {
  if (!ENV.MCP_SAFE_MODE) return false;
  const blocked = new Set(["fs.write", "network", "secrets.write", "process.spawn", "destructive"]);
  return (tool.capabilities || []).some(capability => blocked.has(capability));
}

function pluginsDir(): string {
  return path.resolve(__dirname, "..", "plugins");
}

async function discoverCandidatePluginFiles(): Promise<string[]> {
  const dir = pluginsDir();
  const allowlist = new Set(parseList(ENV.MCP_PLUGIN_ALLOWLIST));
  try {
    await fs.access(dir);
  } catch {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(file => file.isFile())
    .map(file => file.name)
    .filter(fileName => SAFE_BASENAME.test(fileName))
    .filter(fileName => ENV.MCP_PLUGIN_AUTO_DISCOVERY || allowlist.has(fileName))
    .sort();
}

async function computePluginManifestHash(fileNames: string[]): Promise<string> {
  const dir = pluginsDir();
  const hash = createHash("sha256");
  for (const fileName of fileNames) {
    const fullPath = path.resolve(dir, fileName);
    if (!fullPath.startsWith(`${dir}${path.sep}`)) continue;
    const fileHash = createHash("sha256").update(await fs.readFile(fullPath)).digest("hex");
    hash.update(`${fileName}:${fileHash}\n`);
  }
  return hash.digest("hex");
}

export function getLoadedPluginManifestHash(): string | null {
  return loadedPluginManifestHash;
}

export async function assertPluginManifestStable(): Promise<void> {
  if (!ENV.MCP_PLUGIN_PIN_MANIFEST || !loadedPluginManifestHash) return;
  const current = await computePluginManifestHash(await discoverCandidatePluginFiles());
  if (current !== loadedPluginManifestHash) {
    throw new Error("[SUPER-MCP] Plugin manifest changed after startup. Restart deliberately to accept plugin changes.");
  }
}

export class PluginLoader {
  static async loadAll<T = Record<string, unknown>>(): Promise<ToolDefinition<T>[]> {
    const pluginDir = pluginsDir();
    const allowlist = new Set(parseList(ENV.MCP_PLUGIN_ALLOWLIST));
    const hashAllowlist = parseHashAllowlist(ENV.MCP_PLUGIN_SHA256_ALLOWLIST);

    try {
      await fs.access(pluginDir);
    } catch {
      await fs.mkdir(pluginDir, { recursive: true, mode: 0o700 });
      loadedPluginManifestHash = await computePluginManifestHash([]);
      return [];
    }

    const tools: ToolDefinition<T>[] = [];
    const files = await fs.readdir(pluginDir, { withFileTypes: true });

    for (const file of files) {
      if (!file.isFile()) continue;
      if (!SAFE_BASENAME.test(file.name)) continue;
      if (!ENV.MCP_PLUGIN_AUTO_DISCOVERY && !allowlist.has(file.name)) continue;

      const fullPath = path.resolve(pluginDir, file.name);
      if (!fullPath.startsWith(`${pluginDir}${path.sep}`)) {
        console.error(`[SUPER-MCP] Plugin path rejected: ${file.name}`);
        continue;
      }

      if (hashAllowlist.size > 0) {
        const expected = hashAllowlist.get(file.name);
        const actual = createHash("sha256").update(await fs.readFile(fullPath)).digest("hex");
        if (!expected || expected !== actual) {
          console.error(`[SUPER-MCP] Plugin hash rejected: ${file.name}`);
          continue;
        }
      }

      if (ENV.MCP_PLUGIN_AUTO_DISCOVERY && !allowlist.has(file.name)) {
        console.error(`[SUPER-MCP] Unsafe plugin auto-discovery loaded non-allowlisted plugin '${file.name}'.`);
      }

      try {
        const module = await import(`file://${fullPath}`);
        const pluginTools = module.default || module.tools;
        if (!Array.isArray(pluginTools)) {
          console.error(`[SUPER-MCP] Plugin '${file.name}' does not export ToolDefinition[].`);
          continue;
        }

        const accepted = pluginTools.filter((tool: ToolDefinition<T>) => {
          if (!tool?.name || !tool?.handler || !tool?.inputSchema || !tool?.allowedPhases) {
            console.error(`[SUPER-MCP] Invalid tool rejected from plugin '${file.name}'.`);
            return false;
          }
          if (blockedBySafeMode(tool)) {
            console.error(`[SUPER-MCP] Safe mode blocked tool '${tool.name}' from plugin '${file.name}' due to capabilities: ${(tool.capabilities || []).join(",")}`);
            return false;
          }
          return true;
        });

        tools.push(...accepted);
        console.error(`[SUPER-MCP] Plugin loaded '${file.name}' (${accepted.length}/${pluginTools.length} tools accepted)`);
      } catch (error) {
        console.error(`[SUPER-MCP] Plugin load error at '${file.name}':`, error);
      }
    }

    loadedPluginManifestHash = await computePluginManifestHash(await discoverCandidatePluginFiles());
    return tools;
  }
}
