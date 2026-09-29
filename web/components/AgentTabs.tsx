"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { TabStub } from "./TabStub";

/**
 * Profile tab bar. Overview + Attestation + Chat are real routes (SPEC-M4B §3a
 * replaces the Attestation stub, SPEC-M4C §2 the Chat stub); Holders stays an
 * honest "soon" stub.
 */
export function AgentTabs({ agentId }: { agentId: number }) {
  const pathname = usePathname();
  const base = `/agent/${agentId}`;
  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/attestation`, label: "Attestation" },
    { href: `${base}/chat`, label: "Chat" },
  ];

  return (
    <nav className="flex flex-wrap gap-2" aria-label="Agent sections">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md border px-3 py-1.5 text-sm transition ${
              active
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
      <TabStub label="Holders" />
    </nav>
  );
}
