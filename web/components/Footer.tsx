import { CONVENIENCE_LAYER_DISCLAIMER, REPO_URL } from "@/lib/config";

export function Footer() {
  return (
    <footer className="border-t border-slate-800 bg-slate-950">
      <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-slate-500">
        <p className="max-w-3xl">{CONVENIENCE_LAYER_DISCLAIMER}</p>
        <p className="mt-2">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            {REPO_URL}
          </a>
        </p>
      </div>
    </footer>
  );
}
