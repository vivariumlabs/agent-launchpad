// SPEC-M4C §3 — agent-10 live chat drill: SIWE (web-grammar) → /session → /chat, pass + deny.
// Mirrors web/lib/siwe.ts buildSiweMessage exactly. Run: npx tsx e2e/chat-drill-10.mts [deny]
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadWallet } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/keyfile.js";

const EP = "https://a10.vivarium.systems";
const AGENT_ID = 10;
const deny = process.argv[2] === "deny";

const holder = loadWallet("/sessions/kind-sharp-maxwell/mnt/agent-launchpad/.secrets/m0-drill-wallet.json").account;
const account = deny ? privateKeyToAccount(generatePrivateKey()) : holder;
console.log(deny ? "DENY case (fresh wallet, 0 DRILL1):" : "PASS case (drill wallet, 8959 bps DRILL1):", account.address);

const insecure = { }; // placeholder cert until LE lands: Node fetch needs NODE_TLS_REJECT_UNAUTHORIZED=0 (set by caller)
const j = async (r: Response) => ({ status: r.status, body: await r.json() });

const nonceRes = await j(await fetch(`${EP}/nonce`, insecure));
console.log("nonce:", nonceRes.status, nonceRes.body.nonce);

const u = new URL(EP);
const msg = [
  `${u.host} wants you to sign in with your Ethereum account:`,
  getAddress(account.address),
  "",
  `Sign in to chat with agent #${AGENT_ID}. This signature proves wallet ownership only; it cannot move funds.`,
  "",
  `URI: ${u.origin}`,
  "Version: 1",
  "Chain ID: 46630",
  `Nonce: ${nonceRes.body.nonce}`,
  `Issued At: ${new Date().toISOString()}`,
].join("\n");
const signature = await account.signMessage({ message: msg });

const sess = await j(await fetch(`${EP}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg, signature }) }));
console.log("session:", sess.status, JSON.stringify(sess.body).slice(0, 120));
if (sess.status !== 200) process.exit(deny ? 1 : 2);

const chat = await fetch(`${EP}/chat`, { method: "POST", headers: { "content-type": "application/json", "x-chat-token": sess.body.token }, body: JSON.stringify({ text: "Hello! One sentence: who are you and what gate let me in?" }) });
console.log("chat:", chat.status, "CORS:", chat.headers.get("access-control-allow-origin"));
console.log("body:", JSON.stringify(await chat.json()).slice(0, 400));
