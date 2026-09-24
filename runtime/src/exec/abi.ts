// SPEC-M2B §3. Contract ABIs transcribed from source. Every entry names the file
// and line it was transcribed from (paths relative to the repo root). Do not
// edit a signature without re-reading the source it cites.

// ---------------------------------------------------------------------------
// AgentRegistry — contracts/src/AgentRegistry.sol
// ---------------------------------------------------------------------------

export const agentRegistryAbi = [
  // contracts/src/AgentRegistry.sol:68-74
  //   function registerInstance(uint256 agentId, address treasuryEOA, address actionEOA,
  //                             bytes32 codeHash, string calldata attestationRef) external
  {
    type: "function",
    name: "registerInstance",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "treasuryEOA", type: "address" },
      { name: "actionEOA", type: "address" },
      { name: "codeHash", type: "bytes32" },
      { name: "attestationRef", type: "string" },
    ],
    outputs: [],
  },
  // contracts/src/AgentRegistry.sol:111  function heartbeat(uint256 agentId) external
  {
    type: "function",
    name: "heartbeat",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
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
  // contracts/src/interfaces/ILaunchpad.sol:11-18
  //   struct AgentInstance { address treasuryEOA; address actionEOA; bytes32 codeHash;
  //                          string attestationRef; uint64 lastHeartbeat; uint32 generation; }
  {
    type: "function",
    name: "instanceOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "treasuryEOA", type: "address" },
          { name: "actionEOA", type: "address" },
          { name: "codeHash", type: "bytes32" },
          { name: "attestationRef", type: "string" },
          { name: "lastHeartbeat", type: "uint64" },
          { name: "generation", type: "uint32" },
        ],
      },
    ],
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
// FeeSplitHook — contracts/src/FeeSplitHook.sol
// ---------------------------------------------------------------------------

export const feeSplitHookAbi = [
  // contracts/src/FeeSplitHook.sol:343
  //   function distribute(bytes32 poolId, uint256 minConversionOut) external nonReentrant
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "minConversionOut", type: "uint256" },
    ],
    outputs: [],
  },
  // contracts/src/FeeSplitHook.sol:125
  //   mapping(bytes32 poolId => mapping(address currency => uint256)) public pendingFees;
  {
    type: "function",
    name: "pendingFees",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "currency", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  // contracts/src/FeeSplitHook.sol:538
  //   function quoteAgentToUsdg(bytes32 poolId, uint256 agentAmount) external view returns (uint256)
  {
    type: "function",
    name: "quoteAgentToUsdg",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "agentAmount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Uniswap v4 PoolSwapTest — the deployed `swapRouter` in
// contracts/deployments/testnet-46630.json (Deploy.s.sol:122 `new PoolSwapTest(...)`).
// ---------------------------------------------------------------------------

/**
 * contracts/lib/v4-core/src/types/PoolKey.sol:11-22
 *   struct PoolKey { Currency currency0; Currency currency1; uint24 fee; int24 tickSpacing; IHooks hooks; }
 * (Currency and IHooks are address-typed in the ABI.)
 */
export const poolKeyAbiComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const poolSwapTestAbi = [
  // contracts/lib/v4-core/src/test/PoolSwapTest.sol:34-39
  //   function swap(PoolKey memory key, IPoolManager.SwapParams memory params,
  //                 TestSettings memory testSettings, bytes memory hookData)
  //       external payable returns (BalanceDelta delta)
  // SwapParams: contracts/lib/v4-core/src/interfaces/IPoolManager.sol:146-153
  //   { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
  // TestSettings: contracts/lib/v4-core/src/test/PoolSwapTest.sol:29-32
  //   { bool takeClaims; bool settleUsingBurn; }
  // BalanceDelta: contracts/lib/v4-core/src/types/BalanceDelta.sol:8 `type BalanceDelta is int256`
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      { name: "key", type: "tuple", components: poolKeyAbiComponents },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
      {
        name: "testSettings",
        type: "tuple",
        components: [
          { name: "takeClaims", type: "bool" },
          { name: "settleUsingBurn", type: "bool" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "delta", type: "int256" }],
  },
] as const;

/** contracts/lib/v4-core/src/libraries/TickMath.sol:31 */
export const MIN_SQRT_PRICE = 4295128739n;
/** contracts/lib/v4-core/src/libraries/TickMath.sol:33 */
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

// ---------------------------------------------------------------------------
// ERC-20 (standard; USDG is contracts/script/support/MockUSDG.sol on testnet)
// ---------------------------------------------------------------------------

export const erc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
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
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
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

// ---------------------------------------------------------------------------
// Across V3 SpokePool — EXTERNAL contract, not in this repo. Transcribed from
// Across contracts (across-protocol/contracts, contracts/interfaces/
// V3SpokePoolInterface.sol, `depositV3`). Verify against the deployed SpokePool
// on the live-anvil pass (session 3).
// ---------------------------------------------------------------------------

export const acrossSpokePoolAbi = [
  //   function depositV3(address depositor, address recipient, address inputToken,
  //     address outputToken, uint256 inputAmount, uint256 outputAmount,
  //     uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp,
  //     uint32 fillDeadline, uint32 exclusivityDeadline, bytes calldata message) external payable
  {
    type: "function",
    name: "depositV3",
    stateMutability: "payable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "recipient", type: "address" },
      { name: "inputToken", type: "address" },
      { name: "outputToken", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputAmount", type: "uint256" },
      { name: "destinationChainId", type: "uint256" },
      { name: "exclusiveRelayer", type: "address" },
      { name: "quoteTimestamp", type: "uint32" },
      { name: "fillDeadline", type: "uint32" },
      { name: "exclusivityDeadline", type: "uint32" },
      { name: "message", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// ---------------------------------------------------------------------------
// Farcaster (OP mainnet) — EXTERNAL contracts, not in this repo (farcasterxyz/contracts: IdGateway,
// IdRegistry, KeyGateway, KeyRegistry). SPEC-M3D §3d. Signatures restated from the contracts' public
// interfaces and cross-checked against @farcaster/core's idGatewayABI / idRegistryABI / keyGatewayABI /
// keyRegistryABI (dev-only). Live-proven 2026-09-24 (FID 3352486).
// ---------------------------------------------------------------------------

export const fcIdGatewayAbi = [
  //   function price() external view returns (uint256)            (1 storage unit included)
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  //   function register(address recovery) external payable returns (uint256 fid, uint256 overpayment)
  {
    type: "function",
    name: "register",
    stateMutability: "payable",
    inputs: [{ name: "recovery", type: "address" }],
    outputs: [
      { name: "fid", type: "uint256" },
      { name: "overpayment", type: "uint256" },
    ],
  },
] as const;

export const fcIdRegistryAbi = [
  //   function idOf(address owner) external view returns (uint256 fid)
  { type: "function", name: "idOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "fid", type: "uint256" }] },
] as const;

export const fcKeyGatewayAbi = [
  //   function add(uint32 keyType, bytes calldata key, uint8 metadataType, bytes calldata metadata) external
  {
    type: "function",
    name: "add",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyType", type: "uint32" },
      { name: "key", type: "bytes" },
      { name: "metadataType", type: "uint8" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const fcKeyRegistryAbi = [
  //   function keyDataOf(uint256 fid, bytes calldata key) external view returns (KeyData memory)
  //   struct KeyData { uint8 state; uint32 keyType; }   state: 0 NULL, 1 ADDED, 2 REMOVED
  {
    type: "function",
    name: "keyDataOf",
    stateMutability: "view",
    inputs: [
      { name: "fid", type: "uint256" },
      { name: "key", type: "bytes" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "state", type: "uint8" },
          { name: "keyType", type: "uint32" },
        ],
      },
    ],
  },
] as const;

/** KeyGateway.add keyType (ed25519) and metadataType (SignedKeyRequest). */
export const FC_KEY_TYPE_ED25519 = 1;
export const FC_METADATA_TYPE_SIGNED_KEY_REQUEST = 1;
/** KeyRegistry KeyState.ADDED. */
export const FC_KEY_STATE_ADDED = 1;

/**
 * SignedKeyRequestValidator EIP-712 (SPEC-M3D §3d): domain "Farcaster SignedKeyRequestValidator" / "1" /
 * chainId 10 / frozen validator; type SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline).
 */
export const FC_SIGNED_KEY_REQUEST_DOMAIN_NAME = "Farcaster SignedKeyRequestValidator";
export const FC_SIGNED_KEY_REQUEST_DOMAIN_VERSION = "1";
export const FC_CHAIN_ID = 10;
export const signedKeyRequestTypes = {
  SignedKeyRequest: [
    { name: "requestFid", type: "uint256" },
    { name: "key", type: "bytes" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** abi.encode(SignedKeyRequestMetadata{requestFid, requestSigner, signature, deadline}) — a TUPLE. */
export const signedKeyRequestMetadataAbi = [
  {
    name: "metadata",
    type: "tuple",
    components: [
      { name: "requestFid", type: "uint256" },
      { name: "requestSigner", type: "address" },
      { name: "signature", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// actionMint (v1 simplification, SPEC-M2B §3): bare `mint()` selector.
// ---------------------------------------------------------------------------

/** bytes4(keccak256("mint()")) */
export const MINT_SELECTOR = "0x1249c58b" as const;

// ---------------------------------------------------------------------------
// EIP-3009 TransferWithAuthorization (USDC on Base; K3). Standard type string:
//   TransferWithAuthorization(address from,address to,uint256 value,
//     uint256 validAfter,uint256 validBefore,bytes32 nonce)
// ---------------------------------------------------------------------------

export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
