import { keccak256, toBytes } from "viem";
for (const e of ["InvalidQuoteTimestamp()","InvalidFillDeadline()","InvalidOutputToken()","DisabledRoute()","InvalidAmount()"]) console.log(keccak256(toBytes(e)).slice(0,10), e);
