import { identiconFor } from "@/lib/identicon";

/**
 * Deterministic inline-SVG identicon generated from agentId — no external
 * service (SPEC-M4A §2). Rendered whenever imageURI is empty.
 */
export function Identicon({
  agentId,
  size = 48,
  className,
}: {
  agentId: number;
  size?: number;
  className?: string;
}) {
  const { cells, hue } = identiconFor(String(agentId));
  const fg = `hsl(${hue} 65% 60%)`;

  return (
    <svg
      viewBox="0 0 5 5"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={`Identicon for agent ${agentId}`}
    >
      <rect width="5" height="5" fill="#0f172a" />
      {cells.map((row, y) =>
        row.map((on, x) =>
          on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={fg} /> : null,
        ),
      )}
    </svg>
  );
}
