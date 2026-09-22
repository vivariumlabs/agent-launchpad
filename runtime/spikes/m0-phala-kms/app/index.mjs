// M0-1 spike: derive a key inside a Phala CVM via dstack KMS and print its address.
// The derived key must be identical across redeploys of the SAME image/compose,
// and different for a modified image/compose.
import { DstackClient } from "@phala/dstack-sdk";
import { toViemAccount } from "@phala/dstack-sdk/viem";
import http from "node:http";

// KEY_VARIANT is baked into the compose env — changing it changes the compose hash.
const VARIANT = process.env.KEY_VARIANT ?? "v1";

const client = new DstackClient();

async function derive() {
  const info = await client.info();
  const keyRes = await client.getKey("m0-drill", "treasury");
  const account = toViemAccount(keyRes);
  return {
    variant: VARIANT,
    app_id: info.app_id,
    compose_hash: info.tcb_info?.compose_hash ?? info.compose_hash ?? null,
    derived_address: account.address,
  };
}

http
  .createServer(async (_req, res) => {
    try {
      const out = await derive();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out, null, 2));
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(e));
    }
  })
  .listen(8080, () => console.log("m0 kms drill listening on :8080"));
