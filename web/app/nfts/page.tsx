import { NftDashboard } from "@/components/nfts/NftDashboard";
import { getContracts } from "@/lib/api";
import { FIXTURES_MODE } from "@/lib/config";
import { fixtureNftChain } from "@/lib/fixtures";

export const metadata = { title: "Your NFTs — agent-launchpad" };

/** Contract addresses change only on redeploy; refresh occasionally. */
export const revalidate = 300;

/**
 * /nfts — agent NFT dashboard (SPEC-M4E §3). The server reads the deployment
 * addresses from the indexer's /api/contracts (R5: nothing hardcoded); the
 * wallet, its NFT list and every chain read/write are client-side.
 */
export default async function NftsPage() {
  const contracts = await getContracts();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-50">Your NFTs</h1>
        <p className="mt-1 text-sm text-slate-500">
          Each agent NFT earns that agent&apos;s royalty leg in USDG. Claim any time; burning it emancipates the agent
          — its royalties flow to its own treasury forever.
        </p>
      </div>
      <NftDashboard contracts={contracts} fixtures={FIXTURES_MODE} fixtureChain={FIXTURES_MODE ? fixtureNftChain : null} />
      <p className="text-xs text-slate-500">
        Accrued amounts are live contract reads; lifetime totals and ownership come from the indexer. Everything here
        is also possible by calling <span className="font-mono">claim(agentId)</span> on the royalty distributor or{" "}
        <span className="font-mono">burn(agentId)</span> on the agent NFT directly.
      </p>
    </div>
  );
}
