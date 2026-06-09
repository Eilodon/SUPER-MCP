import type { IStateStore } from "./interface.js";
import type { BaseState } from "../types/schemas.js";

export class MemoryStore implements IStateStore {
  private states = new Map<string, BaseState<any>>();
  private backups = new Map<string, BaseState<any>>();

  async load<T = Record<string, unknown>>(tenantId: string): Promise<Partial<BaseState<T>> | null> {
    const state = this.states.get(tenantId);
    return state ? JSON.parse(JSON.stringify(state)) : null; // Deep clone
  }

  async save<T = Record<string, unknown>>(state: BaseState<T>): Promise<void> {
    this.states.set(state.tenantId, JSON.parse(JSON.stringify(state)));
  }

  async saveBackup<T = Record<string, unknown>>(state: BaseState<T>): Promise<void> {
    this.backups.set(state.tenantId, JSON.parse(JSON.stringify(state)));
  }

  async restoreLatestBackup<T = Record<string, unknown>>(tenantId: string): Promise<{ label: string; state: BaseState<T> } | null> {
    const state = this.backups.get(tenantId);
    return state ? { label: "memory_backup", state: JSON.parse(JSON.stringify(state)) } : null;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
