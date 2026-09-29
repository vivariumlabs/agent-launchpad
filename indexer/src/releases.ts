// SPEC-M4B §1a release table — the published runtime releases (runtime/releases/v*.json, written by
// runtime/scripts/release.sh). Each record: {version, imageDigest, imageRef, imageIds: {agentId:
// imageId}, commit, …}. Image-ids are per-(agentId, configHash), so a release's imageIds map is
// exactly the set of enclave measurements it published; an instance's on-chain codeHash (= image-id)
// "matches" when it equals ANY value in ANY release's map (0x-insensitive, case-insensitive).
//
// Loaded at boot and re-read every verify pass (a new release file is picked up without a restart).
// A malformed record is skipped LOUDLY (warned), never fatal: one bad file must not blank the table.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errMsg, type Logger } from "./log.js";

const HEX64_RE = /^(0x)?[0-9a-fA-F]{64}$/;

const ReleaseSchema = z
  .object({
    version: z.string().min(1),
    imageDigest: z.string().min(1),
    imageRef: z.string().min(1),
    imageIds: z.record(z.string().regex(/^[0-9]+$/), z.string().regex(HEX64_RE)),
    commit: z.string().min(1),
  })
  .passthrough();

export interface ReleaseRecord {
  version: string;
  imageDigest: string;
  imageRef: string;
  imageIds: Record<string, string>;
  commit: string;
  /** Source file name (e.g. "v0.1.6.json"). */
  file: string;
}

export interface ReleaseTable {
  dir: string;
  releases: ReleaseRecord[];
}

export interface ReleaseMatch {
  version: string;
  commit: string;
  /** The agentId key under which the image-id was published. */
  agentId: string;
}

/** lowercase, 0x-stripped hex. */
export function normHex(h: string): string {
  const l = h.trim().toLowerCase();
  return l.startsWith("0x") ? l.slice(2) : l;
}

/** "v0.1.10.json" sorts after "v0.1.9.json" (numeric-aware), deterministic. */
function versionCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/** Reads every `v*.json` in `dir`. Throws only when the directory itself is unreadable. */
export function loadReleaseTable(dir: string, log: Logger): ReleaseTable {
  const files = readdirSync(dir)
    .filter((f) => /^v.*\.json$/.test(f))
    .sort(versionCompare);
  const releases: ReleaseRecord[] = [];
  for (const file of files) {
    try {
      const r = ReleaseSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      releases.push({ version: r.version, imageDigest: r.imageDigest, imageRef: r.imageRef, imageIds: r.imageIds, commit: r.commit, file });
    } catch (e) {
      log.warn(`RELEASES: skipping malformed release record ${join(dir, file)}: ${errMsg(e)}`);
    }
  }
  return { dir, releases };
}

/** §1a membership: the release publishing `codeHash`, or null. First match in version order. */
export function matchRelease(table: ReleaseTable, codeHash: string): ReleaseMatch | null {
  const want = normHex(codeHash);
  if (!/^[0-9a-f]{64}$/.test(want)) return null;
  for (const r of table.releases) {
    for (const [agentId, id] of Object.entries(r.imageIds)) {
      if (normHex(id) === want) return { version: r.version, commit: r.commit, agentId };
    }
  }
  return null;
}
