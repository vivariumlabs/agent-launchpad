// Minimal injected logger. Callers only ever pass strings they built from public data (addresses,
// hashes, job ids, amounts) — the wallet key never reaches this module (src/keyfile.ts closure).

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export interface MemoryLogger extends Logger {
  lines: string[];
}

export function memoryLogger(): MemoryLogger {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
  };
}
