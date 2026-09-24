const body = JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "Reply with exactly: VIVARIUM-DRILL-OK" }], max_tokens: 16 });
const r = await fetch("https://agents.dexl.io/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body });
const h = r.headers.get("payment-required");
console.log(JSON.stringify(JSON.parse(Buffer.from(h!, "base64").toString("utf8")), null, 1).slice(0, 1800));
