import Link from "next/link";

import { ConnectButton } from "./ConnectButton";

export function Header() {
  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight text-slate-50">
          agent<span className="text-accent">-launchpad</span>
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href="/launch"
            className="text-sm font-medium text-slate-300 transition hover:text-white"
          >
            Launch
          </Link>
          <Link
            href="/mausoleum"
            className="text-sm font-medium text-slate-300 transition hover:text-white"
          >
            Mausoleum
          </Link>
          <Link
            href="/nfts"
            className="text-sm font-medium text-slate-300 transition hover:text-white"
          >
            Your NFTs
          </Link>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
