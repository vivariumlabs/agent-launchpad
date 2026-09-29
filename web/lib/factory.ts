/**
 * Minimal ABI fragments for the launch flow (SPEC-M4B §3b). Transcribed from
 * contracts/src/interfaces/ILaunchpad.sol (IAgentFactory.createAgent :150,
 * AgentRequested :143) and the standard ERC-20 approve/allowance. Inline on
 * purpose — no cross-package import into the Next bundle (SPEC-M4A §2).
 */

export const factoryAbi = [
  {
    type: "function",
    name: "createAgent",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "imageURI", type: "string" },
      { name: "configHash", type: "bytes32" },
      { name: "creator", type: "address" },
      { name: "expectedTreasuryEOA", type: "address" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "event",
    name: "AgentRequested",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "configHash", type: "bytes32", indexed: false },
      { name: "creator", type: "address", indexed: true },
    ],
    anonymous: false,
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function isAddress(v: string): v is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function isBytes32(v: string): v is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(v);
}

/** Integer string -> bigint, null if not a plain non-negative integer (R6: no floats). */
export function parseUint(v: string): bigint | null {
  if (!/^\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}
