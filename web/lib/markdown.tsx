import { Fragment, type ReactNode } from "react";

/**
 * Tiny dependency-free markdown -> React renderer for docs/public/TRANSPARENCY.md.
 * Supports: #/##/### headings, paragraphs, `>` blockquote, `-` bullet lists,
 * GitHub pipe tables, inline **bold**, *italic*, `code`. Everything is emitted
 * as React elements (escaped by React) — never dangerouslySetInnerHTML.
 * Anything else (links, images, ordered lists, HTML...) renders as plain text.
 */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  const s = line.trim();
  if (!s.includes("-") || !s.includes("|")) return false;
  const cells = splitRow(s);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function isTableStart(lines: string[], i: number): boolean {
  return (lines[i] ?? "").includes("|") && i + 1 < lines.length && isSeparator((lines[i + 1] ?? ""));
}

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? "");
    if (line.trim() === "") {
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: (h[1] ?? "#").length as 1 | 2 | 3, text: h[2] ?? "" });
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow((lines[i] ?? ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").includes("|")) {
        const cells = splitRow((lines[i] ?? ""));
        // Normalise to header width so ragged rows never break the grid.
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^\s*>/.test((lines[i] ?? ""))) {
        parts.push((lines[i] ?? "").replace(/^\s*>\s?/, "").trim());
        i++;
      }
      blocks.push({ kind: "quote", text: parts.join(" ").trim() });
      continue;
    }
    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test((lines[i] ?? ""))) {
        items.push((BULLET.exec(lines[i] ?? "")?.[1] ?? "").trim());
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    // Paragraph: consume until a blank line or the start of another block type.
    const parts: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !HEADING.test((lines[i] ?? "")) &&
      !/^\s*>/.test((lines[i] ?? "")) &&
      !BULLET.test((lines[i] ?? "")) &&
      !isTableStart(lines, i)
    ) {
      parts.push((lines[i] ?? "").trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: parts.join(" ") });
  }
  return blocks;
}

/** Inline: `code`, **bold**, *italic*. Unmatched markers stay as literal text. */
export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let n = 0;
  const flush = () => {
    if (buf !== "") {
      out.push(<Fragment key={`${keyPrefix}-t${n++}`}>{buf}</Fragment>);
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push(
          <code key={`${keyPrefix}-c${n++}`} className="rounded bg-slate-800/80 px-1 py-0.5 font-mono text-[0.85em] text-slate-200">
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    } else if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push(
          <strong key={`${keyPrefix}-b${n++}`} className="font-semibold text-slate-100">
            {renderInline(text.slice(i + 2, end), `${keyPrefix}-b${n}`)}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    } else if (ch === "*" && text[i + 1] !== " " && text[i + 1] !== undefined && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && text[end - 1] !== " ") {
        flush();
        out.push(
          <em key={`${keyPrefix}-e${n++}`} className="italic">
            {renderInline(text.slice(i + 1, end), `${keyPrefix}-e${n}`)}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const H_CLASS: Record<1 | 2 | 3, string> = {
  1: "text-2xl font-semibold text-slate-50",
  2: "mt-4 text-lg font-semibold text-slate-100",
  3: "mt-2 text-sm font-medium text-slate-200",
};

export function renderMarkdown(src: string): ReactNode {
  const blocks = parseBlocks(src);
  return (
    <>
      {blocks.map((b, idx) => {
        const key = `b${idx}`;
        switch (b.kind) {
          case "heading": {
            const Tag = (`h${b.level}`) as "h1" | "h2" | "h3";
            return (
              <Tag key={key} className={H_CLASS[b.level]}>
                {renderInline(b.text, key)}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={key} className="text-sm leading-relaxed text-slate-400">
                {renderInline(b.text, key)}
              </p>
            );
          case "quote":
            return (
              <blockquote
                key={key}
                className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm leading-relaxed text-amber-200/90"
              >
                {renderInline(b.text, key)}
              </blockquote>
            );
          case "list":
            return (
              <ul key={key} className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-slate-400 marker:text-slate-600">
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "table":
            return (
              <div key={key} className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
                <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
                      {b.header.map((c, j) => (
                        <th key={`${key}-h${j}`} className="px-3 py-2 font-medium">
                          {renderInline(c, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {b.rows.map((r, ri) => (
                      <tr key={`${key}-r${ri}`} className="align-top">
                        {r.map((c, ci) => (
                          <td key={`${key}-r${ri}c${ci}`} className="px-3 py-2 leading-relaxed text-slate-400">
                            {renderInline(c, `${key}-r${ri}c${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}
