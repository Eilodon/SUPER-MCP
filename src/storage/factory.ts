import { ENV } from "../config/env.js";
import type { IStateStore } from "./interface.js";
import { LocalFSStore } from "./local_fs.js";
import { RedisStore } from "./redis.js";
import { MemoryStore } from "./memory.js";

export function createStorage(): IStateStore {
  switch (ENV.STORAGE_DRIVER) {
    case "fs":
      console.error("[SUPER-MCP] Khởi tạo Storage Engine: Local File System (VECTOR mode)");
      return new LocalFSStore();
    case "redis":
      console.error("[SUPER-MCP] Khởi tạo Storage Engine: Redis Server (Fortuna mode)");
      return new RedisStore();
    case "memory":
    default:
      console.error("[SUPER-MCP] Khởi tạo Storage Engine: In-Memory (Test mode)");
      return new MemoryStore();
  }
}
