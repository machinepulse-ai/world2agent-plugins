import type { OpenClawPluginEntry } from "./types.js";

export function definePluginEntry<T extends OpenClawPluginEntry>(entry: T): T {
  return entry;
}

