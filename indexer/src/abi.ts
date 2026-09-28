// SPEC-M4A §1 abi.ts — contract ABIs transcribed from source (same discipline as genesis/src/abi.ts).
// Every entry names the file and line it was transcribed from (paths relative to the repo root).
// Do not edit a signature without re-reading the source it cites.

// ---------------------------------------------------------------------------
// AgentFactory — contracts/src/AgentFactory.sol, interface contracts/src/interfaces/ILaunchpad.sol
// ---------------------------------------------------------------------------

/**
 * contracts/src/interfaces/ILaunchpad.sol:133-141
 *   struct PendingAgent { address creator; bytes32 configHash; string imageURI; string name;
 *                         string symbol; uint64 genesisDeadline; bool feePaid; }
 */
const pendingAgentComponents = [
  { name: "creator", type: "address" },
  { name: "configHash", type: "bytes32" },
  { name: "imageURI", type: "string" },
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
  { name: "genesisDeadline", type: "uint64" },
  { name: "feePaid", type: "bool" },
] as const;

export const agentFactoryAbi = [
  // contracts/src/interfaces/ILaunchpad.sol:143
  //   event AgentRequested(uint256 indexed agentId, bytes32 configHash, address indexed creator);
  {
    type: "event",
    name: "AgentRequested",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "configHash", type: "bytes32", indexed: false },
      { name: "creator", type: "address", indexed: true },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:144
  //   event AgentLive(uint256 indexed agentId, address token, address curve);
  {
    type: "event",
    name: "AgentLive",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "curve", type: "address", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:145
  //   event AgentCancelled(uint256 indexed agentId);
  {
    type: "event",
    name: "AgentCancelled",
    anonymous: false,
    inputs: [{ name: "agentId", type: "uint256", indexed: true }],
  },
  // contracts/src/interfaces/ILaunchpad.sol:146
  //   event AgentGraduated(uint256 indexed agentId, uint256 poolUsdg, uint256 poolTokens, uint256 burned);
  {
    type: "event",
    name: "AgentGraduated",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "poolUsdg", type: "uint256", indexed: false },
      { name: "poolTokens", type: "uint256", indexed: false },
      { name: "burned", type: "uint256", indexed: false },
    ],
  },
  // contracts/src/AgentFactory.sol:382
  //   function pendingAgent(uint256 agentId) external view returns (PendingAgent memory)
  {
    type: "function",
    name: "pendingAgent",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: pendingAgentComponents }],
  },
  // contracts/src/AgentFactory.sol:126  mapping(uint256 agentId => address) public tokenOf;
  {
    type: "function",
    name: "tokenOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  // contracts/src/AgentFactory.sol:128  mapping(uint256 agentId => address) public curveOf;
  {
    type: "function",
    name: "curveOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  // contracts/src/AgentFactory.sol:120  uint256 public agentCount;
  {
    type: "function",
    name: "agentCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ---------------------------------------------------------------------------
// AgentRegistry — contracts/src/AgentRegistry.sol, interface ILaunchpad.sol IAgentRegistry
// ---------------------------------------------------------------------------

/**
 * contracts/src/interfaces/ILaunchpad.sol:11-18
 *   struct AgentInstance { address treasuryEOA; address actionEOA; bytes32 codeHash;
 *                          string attestationRef; uint64 lastHeartbeat; uint32 generation; }
 */
const agentInstanceComponents = [
  { name: "treasuryEOA", type: "address" },
  { name: "actionEOA", type: "address" },
  { name: "codeHash", type: "bytes32" },
  { name: "attestationRef", type: "string" },
  { name: "lastHeartbeat", type: "uint64" },
  { name: "generation", type: "uint32" },
] as const;

export const agentRegistryAbi = [
  // contracts/src/interfaces/ILaunchpad.sol:20
  //   event GenesisOpened(uint256 indexed agentId, uint64 deadline);
  {
    type: "event",
    name: "GenesisOpened",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "deadline", type: "uint64", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:21-23
  //   event InstanceRegistered(uint256 indexed agentId, address treasuryEOA, address actionEOA,
  //                            bytes32 codeHash, uint32 generation);
  {
    type: "event",
    name: "InstanceRegistered",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "treasuryEOA", type: "address", indexed: false },
      { name: "actionEOA", type: "address", indexed: false },
      { name: "codeHash", type: "bytes32", indexed: false },
      { name: "generation", type: "uint32", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:24
  //   event Heartbeat(uint256 indexed agentId, uint64 timestamp);
  {
    type: "event",
    name: "Heartbeat",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "timestamp", type: "uint64", indexed: false },
    ],
  },
  // contracts/src/AgentRegistry.sol:119  function isRegistered(uint256 agentId) public view returns (bool)
  {
    type: "function",
    name: "isRegistered",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  // contracts/src/AgentRegistry.sol:128
  //   function instanceOf(uint256 agentId) external view returns (AgentInstance memory)
  //   (never reverts: an unregistered agent returns the zero struct, lastHeartbeat == 0 — :119-121)
  {
    type: "function",
    name: "instanceOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: agentInstanceComponents }],
  },
  // contracts/src/AgentRegistry.sol:13  uint64 public constant REVIVAL_WINDOW = 7 days;
  {
    type: "function",
    name: "REVIVAL_WINDOW",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

// ---------------------------------------------------------------------------
// FeeSplitHook — contracts/src/FeeSplitHook.sol, interface ILaunchpad.sol IFeeSplitHook
// ---------------------------------------------------------------------------

export const feeSplitHookAbi = [
  // contracts/src/interfaces/ILaunchpad.sol:97
  //   event PoolRegistered(bytes32 indexed poolId, uint256 indexed agentId, address agentToken);
  {
    type: "event",
    name: "PoolRegistered",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentToken", type: "address", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:98
  //   event FeeCollected(bytes32 indexed poolId, address currency, uint256 amount);
  {
    type: "event",
    name: "FeeCollected",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "currency", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:99-101
  //   event Distributed(bytes32 indexed poolId, uint256 buybackLeg, uint256 treasuryLeg,
  //                     uint256 royaltyLeg, uint256 converted);
  {
    type: "event",
    name: "Distributed",
    anonymous: false,
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "buybackLeg", type: "uint256", indexed: false },
      { name: "treasuryLeg", type: "uint256", indexed: false },
      { name: "royaltyLeg", type: "uint256", indexed: false },
      { name: "converted", type: "uint256", indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// RoyaltyDistributor — contracts/src/RoyaltyDistributor.sol, interface ILaunchpad.sol IRoyaltyDistributor
// ---------------------------------------------------------------------------

export const royaltyDistributorAbi = [
  // contracts/src/interfaces/ILaunchpad.sol:48  event Credited(uint256 indexed agentId, uint256 amount);
  {
    type: "event",
    name: "Credited",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:49
  //   event Claimed(uint256 indexed agentId, address indexed to, uint256 amount);
  {
    type: "event",
    name: "Claimed",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:50
  //   event Emancipated(uint256 indexed agentId, uint256 sweptToTreasury);
  {
    type: "event",
    name: "Emancipated",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "sweptToTreasury", type: "uint256", indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// AgentBondingCurve (one clone per agent) — contracts/src/AgentBondingCurve.sol,
// interface ILaunchpad.sol IAgentBondingCurve. No agentId in these events: the emitting curve
// address resolves to its agent via the agents row written at AgentLive (AgentFactory.sol:270-276).
// ---------------------------------------------------------------------------

export const bondingCurveAbi = [
  // contracts/src/interfaces/ILaunchpad.sol:70
  //   event Bought(address indexed buyer, uint256 usdgIn, uint256 tokensOut, uint256 fee);
  {
    type: "event",
    name: "Bought",
    anonymous: false,
    inputs: [
      { name: "buyer", type: "address", indexed: true },
      { name: "usdgIn", type: "uint256", indexed: false },
      { name: "tokensOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:71
  //   event Sold(address indexed seller, uint256 tokensIn, uint256 usdgOut, uint256 fee);
  {
    type: "event",
    name: "Sold",
    anonymous: false,
    inputs: [
      { name: "seller", type: "address", indexed: true },
      { name: "tokensIn", type: "uint256", indexed: false },
      { name: "usdgOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  // contracts/src/interfaces/ILaunchpad.sol:72
  //   event Graduated(uint256 usdgSwept, uint256 tokensSwept);
  {
    type: "event",
    name: "Graduated",
    anonymous: false,
    inputs: [
      { name: "usdgSwept", type: "uint256", indexed: false },
      { name: "tokensSwept", type: "uint256", indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// TreasuryBuyback (platform-wide, no agentId) — contracts/src/TreasuryBuyback.sol,
// interface ILaunchpad.sol ITreasuryBuyback
// ---------------------------------------------------------------------------

export const treasuryBuybackAbi = [
  // contracts/src/interfaces/ILaunchpad.sol:126
  //   event Poked(address indexed caller, uint256 usdgIn, uint256 tokensBurned, uint256 callerReward);
  {
    type: "event",
    name: "Poked",
    anonymous: false,
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "usdgIn", type: "uint256", indexed: false },
      { name: "tokensBurned", type: "uint256", indexed: false },
      { name: "callerReward", type: "uint256", indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Uniswap v4 PoolManager — contracts/lib/v4-core/src/interfaces/IPoolManager.sol
// ---------------------------------------------------------------------------

export const poolManagerAbi = [
  // contracts/lib/v4-core/src/interfaces/IPoolManager.sol:90-99
  //   event Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
  //              uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee);
  //   (PoolId is `type PoolId is bytes32` — v4-core/src/types/PoolId.sol — so the ABI type is bytes32.)
  {
    type: "event",
    name: "Swap",
    anonymous: false,
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// AgentNFT (ERC-721, tokenId == agentId) — contracts/src/AgentNFT.sol
// ---------------------------------------------------------------------------

export const agentNftAbi = [
  // contracts/lib/openzeppelin-contracts/contracts/token/ERC721/IERC721.sol:15
  //   event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
  // contracts/src/AgentNFT.sol:89  function tokenURI(uint256 tokenId) public view override returns (string memory)
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

// ---------------------------------------------------------------------------
// ERC-20 (USDG / AgentToken) — contracts/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol
// and extensions/IERC20Metadata.sol
// ---------------------------------------------------------------------------

export const erc20Abi = [
  // IERC20.sol:27  function totalSupply() external view returns (uint256);
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // IERC20.sol:32  function balanceOf(address account) external view returns (uint256);
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // extensions/IERC20Metadata.sol:15  function name() external view returns (string memory);
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  // extensions/IERC20Metadata.sol:20  function symbol() external view returns (string memory);
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;
