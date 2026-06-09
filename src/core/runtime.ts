import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ENV } from "../config/env.js";
import { createStorage } from "../storage/factory.js";
import { telemetry } from "../telemetry/factory.js";
import { closeMiddlewareResources, registerTools, type GetStateOptions, type ToolDefinition } from "./registrar.js";
import { BaseStateSchema, type BaseState } from "../types/schemas.js";

function cloneState<T>(state: BaseState<T>): BaseState<T> {
  return JSON.parse(JSON.stringify(state));
}

export class SuperMcpRuntime<T = Record<string, unknown>> {
  private server!: McpServer;
  private storage = createStorage();
  private states = new Map<string, BaseState<T>>();

  constructor(private version: string, private tools: ToolDefinition<T>[]) {}

  private createServer(): McpServer {
    const server = new McpServer({
      name: "super-mcp-server",
      version: this.version,
    });
    registerTools(server, this.tools, (tenantId, options) => this.getState(tenantId, options), state => this.saveState(state));
    return server;
  }

  async initialize(): Promise<void> {
    await telemetry.log("server_initializing", { version: this.version });
    await this.getState(ENV.MCP_TENANT_ID, { reload: true });
    this.server = this.createServer();
    await telemetry.log("server_initialized", { phase: this.states.get(ENV.MCP_TENANT_ID)?.phase });
  }

  private async loadOrCreateState(tenantId: string): Promise<BaseState<T>> {
    const rawState = await this.storage.load<T>(tenantId);
    if (!rawState) {
      const state: BaseState<T> = {
        version: this.version,
        tenantId,
        revision: 0,
        phase: "intake",
        logs: { decisions: [] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payload: {} as T,
      };
      this.states.set(tenantId, state);
      await this.saveState(state);
      await telemetry.log("state_initialized_default", { tenantId, phase: state.phase });
      return cloneState(state);
    }

    const parsed = BaseStateSchema.parse({ ...rawState, tenantId, version: this.version }) as BaseState<T>;
    this.states.set(tenantId, parsed);
    await telemetry.log("state_loaded_existing", { tenantId, phase: parsed.phase, revision: parsed.revision });
    return cloneState(parsed);
  }

  async getState(tenantId = ENV.MCP_TENANT_ID, options: GetStateOptions = {}): Promise<BaseState<T>> {
    if (options.reload || !this.states.has(tenantId)) {
      return this.loadOrCreateState(tenantId);
    }
    return cloneState(this.states.get(tenantId)!);
  }

  async saveState(state: BaseState<T>): Promise<void> {
    const nextState = cloneState(state);
    nextState.updatedAt = new Date().toISOString();
    nextState.revision = (nextState.revision ?? 0) + 1;
    await this.storage.save(nextState);
    this.states.set(nextState.tenantId, cloneState(nextState));
  }

  async getDefaultState(): Promise<BaseState<T>> {
    return this.getState(ENV.MCP_TENANT_ID);
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
    await telemetry.log("server_connected", { transport: transport.constructor.name });
  }

  async connectEphemeral(transport: Transport): Promise<McpServer> {
    const server = this.createServer();
    await server.connect(transport);
    await telemetry.log("server_connected", { transport: transport.constructor.name, ephemeral: true });
    return server;
  }

  async requestSampling(params: any) {
    return await this.server.server.createMessage(params);
  }

  async requestElicitation(params: any) {
    return await this.server.server.elicitInput(params);
  }

  async healthCheck(): Promise<boolean> {
    return this.storage.healthCheck ? await this.storage.healthCheck() : true;
  }

  async close(): Promise<void> {
    await telemetry.log("server_shutting_down", { version: this.version });
    for (const state of this.states.values()) {
      await this.saveState(state);
    }
    if (this.server) {
      await this.server.close();
    }
    await closeMiddlewareResources();
    if (this.storage.close) {
      await this.storage.close();
    }
  }
}
