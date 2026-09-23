// SPEC-M3B §1 — contract ABIs transcribed from source (same discipline as runtime/src/exec/abi.ts).
// Every entry names the file and line it was transcribed from (paths relative to the repo root).
// Do not edit a signature without re-reading the source it cites. The anvil integration suite
// (test/integration/genesis.int.test.ts) checks every entry against the forge-compiled artifact ABI.

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
  // contracts/src/AgentFactory.sol:203-210 (ILaunchpad.sol:150-157)
  //   function createAgent(string calldata name, string calldata symbol, string calldata imageURI,
  //     bytes32 configHash, address creator, address expectedTreasuryEOA)
  //     external payable returns (uint256 agentId)
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
  // contracts/src/AgentFactory.sol:244  function finalize(uint256 agentId) external nonReentrant
  {
    type: "function",
    name: "finalize",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
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
  // contracts/src/AgentFactory.sol:74  uint256 public constant CREATION_FEE = 75e6;
  {
    type: "function",
    name: "CREATION_FEE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
// AgentRegistry — contracts/src/AgentRegistry.sol
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
  {
    type: "function",
    name: "instanceOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: agentInstanceComponents }],
  },
  // contracts/src/AgentRegistry.sol:27  mapping(uint256 => address) public expectedTreasuryEOA;
  {
    type: "function",
    name: "expectedTreasuryEOA",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  // contracts/src/AgentRegistry.sol:21  mapping(uint256 => uint64) public genesisDeadline;
  {
    type: "function",
    name: "genesisDeadline",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
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
// ERC-20 (USDG / MockUSDG / Base USDC) —
// contracts/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol
// ---------------------------------------------------------------------------

export const erc20Abi = [
  // IERC20.sol:16  event Transfer(address indexed from, address indexed to, uint256 value);
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  // IERC20.sol:32  function balanceOf(address account) external view returns (uint256);
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // IERC20.sol:41  function transfer(address to, uint256 value) external returns (bool);
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
