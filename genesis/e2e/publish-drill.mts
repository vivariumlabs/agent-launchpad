// SPEC-M4E §4.2 — live publish + discovery drill (free: <100 KiB Turbo upload, winc 0).
// Publishes agents/8's exact agent.json text, then (arg "find") discovers it by ConfigHash tag.
import { readFileSync } from "node:fs";
import { publishFrozenConfig } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/arweavePublish.js";
import { ArweaveTagConfigSource, verifyFrozen } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/configSource.js";
import { createArweaveReader } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/arweavePublish.js";
import { frozenConfigHash } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/canonical.js";
import { fetchHttp } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/http.js";

const text = readFileSync("/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/e2e/data/agents/8/agent.json", "utf8");
const cfg = JSON.parse(text) as { platform: unknown; agent: unknown };
const hash = frozenConfigHash({ platform: cfg.platform, agent: cfg.agent });
console.log("configHash:", hash);

if (process.argv[2] === "find") {
  const src = new ArweaveTagConfigSource({
    graphqlUrl: "https://arweave.net/graphql",
    http: fetchHttp,
    reader: createArweaveReader({ gatewayUrl: "https://arweave.net", timeoutMs: 20_000 }),
    timeoutMs: 20_000,
    log: { info: console.log, warn: console.warn, error: console.error },
  });
  const doc = await src.load({ configHash: hash });
  if (doc === null) {
    console.log("DISCOVERY: null (GraphQL lag? retry)");
    process.exit(3);
  }
  console.log("DISCOVERY: found", doc.ref, "bytes:", Buffer.byteLength(doc.text));
  console.log("byte-exact:", doc.text === text);
  verifyFrozen(doc.text, hash, 8);
  console.log("verifyFrozen: OK");
} else {
  const { createEphemeralUploader } = await import("/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/arweavePublish.js");
  const r = await publishFrozenConfig(text, { uploader: createEphemeralUploader(), clock: { now: () => BigInt(Math.floor(Date.now() / 1000)) } });
  console.log("published:", r.txId, "->", `https://arweave.net/${r.txId}`);
}
