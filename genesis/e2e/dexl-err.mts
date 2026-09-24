const r1 = await fetch("https://agents.dexl.io/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }) });
const j = await r1.json();
console.log("error msg:", JSON.stringify(j.error ?? j).slice(0, 900));
console.log("accepts[0] extra:", JSON.stringify((j.accepts ?? [])[0]?.extra ?? {}).slice(0, 300));
console.log("accepts[0] keys:", Object.keys((j.accepts ?? [])[0] ?? {}));
