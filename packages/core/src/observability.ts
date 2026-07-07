import type { CloneOptions, FileMap } from "./types.js";
import { fileMapStats } from "./collectFileMap.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type ServiceLogger = (event: string, fields?: LogFields, level?: LogLevel) => void;

function jsonSafe(value: unknown): unknown {
  if (value instanceof Error) return errorFields(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function createJsonLogger(service: string): ServiceLogger {
  return (event, fields = {}, level = "info") => {
    const payload: LogFields = {
      ts: new Date().toISOString(),
      level,
      service,
      event,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) payload[key] = jsonSafe(value);
    }
    const line = JSON.stringify(payload);
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
}

export function errorFields(error: unknown, max = 500): LogFields {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, max),
    };
  }
  return { message: String(error).slice(0, max) };
}

export function summarizeCloneOptions(options?: CloneOptions): LogFields {
  return {
    mode: options?.mode,
    styling: options?.styling,
    framework: options?.framework,
    verify: options?.verify,
    asyncVerify: options?.asyncVerify,
    preview: options?.preview,
    noCache: options?.noCache,
    maxRoutes: options?.maxRoutes,
    maxCollection: options?.maxCollection,
    captureConcurrency: options?.captureConcurrency,
    validationConcurrency: options?.validationConcurrency,
    viewportConcurrency: options?.viewportConcurrency,
  };
}

export function summarizeFileMap(files: FileMap): LogFields {
  const stats = fileMapStats(files);
  let textFiles = 0;
  let binaryFiles = 0;
  for (const file of Object.values(files)) {
    if (file.kind === "text") textFiles++;
    else binaryFiles++;
  }
  return { ...stats, textFiles, binaryFiles };
}
