# agent-launchpad

Autonomous on-chain agents: genesis orchestrator, TEE runtime, chain indexer, and the directory/profile website.

## Run the site

Start the indexer against testnet, then point the site at it:

```
npm --prefix indexer start -- --config indexer/e2e/testnet.json
INDEXER_URL=http://127.0.0.1:8425 npm --prefix web run dev
```

Fixtures mode (no indexer needed): run `npm --prefix web run dev` with `INDEXER_URL` unset — the site serves the three fixture agents from `web/fixtures/`.
