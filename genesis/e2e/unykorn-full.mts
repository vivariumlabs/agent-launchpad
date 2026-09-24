const r = await fetch("https://twin.unykorn.org/llm", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "x", }) });
console.log("bare:", r.status, JSON.stringify(await r.json().catch(()=>({}))).slice(0,400));
