import { createPublicClient, http, defineChain } from "viem";
const rh = defineChain({ id: 46630, name: "rh", nativeCurrency: {name:"ETH",symbol:"ETH",decimals:18}, rpcUrls: {default:{http:["https://rpc.testnet.chain.robinhood.com"]}} });
const pub = createPublicClient({ chain: rh, transport: http() });
const abi = [{ type: "function", name: "instanceOf", stateMutability: "view", inputs: [{name:"agentId",type:"uint256"}], outputs: [{name:"",type:"tuple",components:[{name:"treasuryEOA",type:"address"},{name:"actionEOA",type:"address"},{name:"codeHash",type:"bytes32"},{name:"attestationRef",type:"string"},{name:"lastHeartbeat",type:"uint64"},{name:"generation",type:"uint32"}]}]}] as const;
const i = await pub.readContract({ address: "0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59", abi, functionName: "instanceOf", args: [8n] });
console.log(JSON.stringify(i, (_,v)=>typeof v==="bigint"?v.toString():v, 1));
