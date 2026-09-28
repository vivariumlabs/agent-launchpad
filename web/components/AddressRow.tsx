import { CopyButton } from "./CopyButton";
import { truncateAddress } from "@/lib/format";
import { EXPLORER_ADDRESS_BASE_URL } from "@/lib/config";

export function AddressRow({
  label,
  address,
}: {
  label: string;
  address: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-slate-500">{label}</span>
      {address ? (
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-slate-300">{truncateAddress(address)}</span>
          <CopyButton value={address} label={label} />
          {EXPLORER_ADDRESS_BASE_URL ? (
            <a
              href={`${EXPLORER_ADDRESS_BASE_URL}${address}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-accent hover:underline"
            >
              explorer ↗
            </a>
          ) : null}
        </span>
      ) : (
        <span className="text-slate-600">—</span>
      )}
    </div>
  );
}
