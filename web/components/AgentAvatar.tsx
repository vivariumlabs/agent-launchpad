import { Identicon } from "./Identicon";

/**
 * imageURI is null for all current agents (and for a "requested" agent, so
 * is name) — always render the identicon fallback in that case (SPEC-M4A
 * §2). Plain <img>, not next/image, since no remote hosts are configured for
 * optimization.
 */
export function AgentAvatar({
  agentId,
  imageURI,
  name,
  size = 48,
  className,
}: {
  agentId: number;
  imageURI: string | null;
  name: string | null;
  size?: number;
  className?: string;
}) {
  const alt = name ?? `Agent #${agentId}`;
  if (imageURI) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageURI}
        alt={alt}
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size, objectFit: "cover" }}
      />
    );
  }
  return <Identicon agentId={agentId} size={size} className={className} />;
}
