#!/usr/bin/env bash
# M0-4 drill (the part that still exists): provision an inference key via the
# management API, make a model call with it, read remaining credits.
# Usage: OR_MANAGEMENT_KEY=... ./provision-drill.sh
set -euo pipefail
: "${OR_MANAGEMENT_KEY:?set OR_MANAGEMENT_KEY (an OpenRouter management/provisioning key)}"

echo "== 1. create a scoped inference key =="
CREATE=$(curl -sf https://openrouter.ai/api/v1/keys \
  -H "Authorization: Bearer $OR_MANAGEMENT_KEY" -H "Content-Type: application/json" \
  -d '{"name":"m0-drill-key","limit":1}')
echo "$CREATE"
KEY=$(echo "$CREATE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
HASH=$(echo "$CREATE" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("data",{}).get("hash",""))')

echo "== 2. inference call with the new key =="
curl -sf https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Say M0-OK"}],"max_tokens":10}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["choices"][0]["message"]["content"])'

echo "== 3. remaining credits =="
curl -sf https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $OR_MANAGEMENT_KEY"

echo
echo "== 4. cleanup: delete drill key =="
[ -n "$HASH" ] && curl -sf -X DELETE "https://openrouter.ai/api/v1/keys/$HASH" \
  -H "Authorization: Bearer $OR_MANAGEMENT_KEY" && echo "deleted"
