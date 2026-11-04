// Pharos dApp Support Agent - Advanced EVM Diagnostic & Revert Explainer
// Zero-dependency pure ESM module for Pharos Pacific Mainnet (Chain ID 1672) & Atlantic Testnet

// pacific-rpc.pharos.xyz, which this file used to point at, has no A record at
// all. rpc.pharos.xyz answers eth_chainId with 0x688 (1672), the Pacific
// Mainnet chain id, so that is the one the docs and the explorer agree on.
export const DEFAULT_PHAROS_RPC = "https://rpc.pharos.xyz";

// A hung RPC must not hang the caller: the Pages Function has its own wall clock
// and a browser tab waiting on a spinner is worse than an honest timeout.
export const RPC_TIMEOUT_MS = 10000;

export const PANIC_CODES = {
  0x00: "Generic compiler panic / unknown",
  0x01: "Assertion failed (assert(false))",
  0x11: "Arithmetic operation underflowed or overflowed outside unchecked block",
  0x12: "Division or modulo by zero (e.g. 5 / 0 or 5 % 0)",
  0x21: "Conversion into an out-of-bounds or invalid enum value",
  0x22: "Storage byte array encoded incorrectly / invalid length prefix",
  0x31: "Array .pop() called on an empty array",
  0x32: "Array or slice index out of bounds access",
  0x41: "Out of memory / excessive memory allocation",
  0x51: "Called uninitialized internal function pointer"
};

// ---------------------------------------------------------------------------
// Keccak-256, from scratch. 70 lines instead of a dependency, because the one
// thing this module must never get wrong is which error a selector names.
// Selectors are hashed from their signatures at load time rather than typed
// into a table: a typo in a signature is then a wrong hash (caught by tests),
// not a silently mislabelled error that tells a user to unpause a contract
// that was never paused.
// ---------------------------------------------------------------------------
const MASK64 = (1n << 64n) - 1n;

const KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

// rho rotation offsets, indexed lane = x + 5y
const KECCAK_RHO = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14
];

function rotl64(value, bits) {
  if (bits === 0) return value;
  const b = BigInt(bits);
  return ((value << b) | (value >> (64n - b))) & MASK64;
}

function keccakF1600(lanes) {
  const a = lanes;
  const b = new Array(25).fill(0n);
  const c = new Array(5).fill(0n);
  const d = new Array(5).fill(0n);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) a[i] ^= d[i % 5];

    b.fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y], KECCAK_RHO[x + 5 * y]);
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        a[x + 5 * y] =
          b[x + 5 * y] ^
          (((~b[((x + 1) % 5) + 5 * y] & MASK64)) & b[((x + 2) % 5) + 5 * y]);
      }
    }
    a[0] ^= KECCAK_ROUND_CONSTANTS[round];
  }
}

/** Keccak-256 over raw bytes. Works in Node and in the browser (no Buffer). */
export function keccak256(bytes) {
  const rate = 136;
  const padLength = rate - (bytes.length % rate);
  const buf = new Uint8Array(bytes.length + padLength);
  buf.set(bytes);
  buf[bytes.length] ^= 0x01;
  buf[buf.length - 1] ^= 0x80;

  const lanes = new Array(25).fill(0n);
  for (let offset = 0; offset < buf.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) {
        lane |= BigInt(buf[offset + i * 8 + j]) << BigInt(8 * j);
      }
      lanes[i] ^= lane;
    }
    keccakF1600(lanes);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = lanes[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

function toHex(bytes, limit = bytes.length) {
  let hex = "";
  for (let i = 0; i < limit; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * Canonical ABI signature: parameter names are not part of the hash, so
 * "transfer(address to, uint256 amount)" and "transfer(address,uint256)" must
 * produce the same selector.
 */
export function canonicalSignature(signature) {
  const match = String(signature).match(/^\s*([A-Za-z0-9_$]+)\s*\((.*)\)\s*$/);
  if (!match) return String(signature).replace(/\s+/g, "");
  const args = match[2].trim();
  const canonicalArgs = args === ""
    ? ""
    : args
        .split(",")
        .map((arg) => arg.trim().split(/\s+/)[0])
        .join(",");
  return `${match[1]}(${canonicalArgs})`;
}

/** 4-byte selector for an error/function signature, e.g. "Error(string)". */
export function selectorOf(signature) {
  const canonical = canonicalSignature(signature);
  const bytes = new TextEncoder().encode(canonical);
  return `0x${toHex(keccak256(bytes), 4)}`;
}

// ---------------------------------------------------------------------------
// Custom error catalog. Only signatures live here; selectors are derived.
// Every entry below has been checked against the compiled contract source it
// claims to come from. Order is irrelevant.
// ---------------------------------------------------------------------------
export const CUSTOM_ERROR_CATALOG = [
  // --- OpenZeppelin v5 ERC-20 ---
  {
    signature: "ERC20InsufficientBalance(address,uint256,uint256)",
    category: "ERC-20",
    description: "Sender token balance is lower than the amount required for transfer."
  },
  {
    signature: "ERC20InsufficientAllowance(address,uint256,uint256)",
    category: "ERC-20",
    description: "Spender allowance is lower than the amount requested to transfer."
  },
  {
    signature: "ERC20InvalidApprover(address)",
    category: "ERC-20",
    description: "Approval attempted from an address that cannot approve (typically the zero address)."
  },
  {
    signature: "ERC20InvalidSpender(address)",
    category: "ERC-20",
    description: "Approval granted to an invalid spender (typically the zero address)."
  },
  {
    signature: "ERC20InvalidSender(address)",
    category: "ERC-20",
    description: "Transfer initiated from an invalid sender (typically the zero address)."
  },
  {
    signature: "ERC20InvalidReceiver(address)",
    category: "ERC-20",
    description: "Transfer sent to an invalid receiver (typically the zero address)."
  },
  // --- OpenZeppelin v5 Ownable ---
  {
    signature: "OwnableUnauthorizedAccount(address)",
    category: "AccessControl",
    description: "Caller is not the owner of the contract."
  },
  {
    signature: "OwnableInvalidOwner(address)",
    category: "AccessControl",
    description: "Ownership was assigned to an invalid owner (typically the zero address)."
  },
  // --- OpenZeppelin v5 AccessControl ---
  {
    signature: "AccessControlUnauthorizedAccount(address,bytes32)",
    category: "AccessControl",
    description: "Caller is missing the role required for this function."
  },
  {
    signature: "AccessControlBadConfirmation()",
    category: "AccessControl",
    description: "Role transfer was confirmed by an account other than the pending holder."
  },
  // --- OpenZeppelin v5 Pausable ---
  {
    signature: "EnforcedPause()",
    category: "Lifecycle",
    description: "Contract execution is halted because emergency pause is active."
  },
  {
    signature: "ExpectedPause()",
    category: "Lifecycle",
    description: "Operation requires the contract to be paused, but it is currently unpaused."
  },
  // --- OpenZeppelin v5 ReentrancyGuard ---
  {
    signature: "ReentrancyGuardReentrantCall()",
    category: "Security",
    description: "Reentrancy guard triggered by recursive or re-entered external call."
  },
  // --- OpenZeppelin v5 SafeERC20 ---
  {
    signature: "SafeERC20FailedOperation(address)",
    category: "ERC-20",
    description: "Token returned false or reverted without data inside a SafeERC20 operation."
  },
  // --- OpenZeppelin v5 ERC-721 / ERC-1155 ---
  {
    signature: "ERC721NonexistentToken(uint256)",
    category: "ERC-721",
    description: "Queried token id has never been minted."
  },
  {
    signature: "ERC1155InsufficientBalance(address,uint256,uint256,uint256)",
    category: "ERC-1155",
    description: "Account holds fewer units of the token id than the transfer requires."
  },
  // --- Common DeFi / dApp validations ---
  {
    signature: "Unauthorized()",
    category: "AccessControl",
    description: "Caller does not possess required role or permission."
  },
  {
    signature: "InvalidCaller()",
    category: "AccessControl",
    description: "Transaction caller is not recognized or allowed."
  },
  {
    signature: "ZeroAddress()",
    category: "Validation",
    description: "Target address or parameter cannot be the zero address."
  },
  {
    signature: "InvalidAmount()",
    category: "Validation",
    description: "Amount provided is zero or exceeds a permitted boundary."
  },
  {
    signature: "TransferFailed()",
    category: "DeFi",
    description: "Native PROS or ERC-20 transfer failed inside smart contract execution."
  },
  {
    signature: "DeadlineExpired()",
    category: "DEX/DeFi",
    description: "DEX swap or transaction executed past its block timestamp deadline."
  },
  {
    signature: "SlippageExceeded()",
    category: "DEX/DeFi",
    description: "Output received is below the caller's minimum acceptable amount."
  }
];

/**
 * Build the selector -> error map by hashing each catalog signature.
 * Exported for tests; consumers should use KNOWN_CUSTOM_ERRORS.
 */
export function buildCustomErrorTable(catalog = CUSTOM_ERROR_CATALOG) {
  const table = {};
  for (const entry of catalog) {
    const selector = selectorOf(entry.signature);
    if (table[selector]) {
      throw new Error(
        `Duplicate selector ${selector}: "${entry.signature}" collides with "${table[selector].signature}"`
      );
    }
    table[selector] = {
      ...entry,
      name: entry.signature.slice(0, entry.signature.indexOf("(")),
      signature: canonicalSignature(entry.signature)
    };
  }
  return table;
}

export const KNOWN_CUSTOM_ERRORS = buildCustomErrorTable();

/**
 * Decode EVM revert data (Error(string), Panic(uint256), Custom Errors, or Empty)
 * @param {string} returnData Hex return data string
 * @returns {object} Decoded revert details
 */
export function decodeRevertReason(returnData) {
  if (!returnData || returnData === "0x" || returnData.length < 10) {
    return {
      type: "EMPTY_OR_UNKNOWN",
      selector: "0x",
      name: "EmptyRevert",
      message: "Transaction reverted without returning any error bytecode or revert message.",
      category: "Generic"
    };
  }

  const cleanData = returnData.startsWith("0x") ? returnData : `0x${returnData}`;
  const selector = cleanData.slice(0, 10).toLowerCase();

  // 1. Standard Error(string) -> 0x08c379a0
  if (selector === "0x08c379a0" && cleanData.length >= 138) {
    try {
      const length = parseInt(cleanData.slice(74, 138), 16);
      const strHex = cleanData.slice(138, 138 + length * 2);
      let reason = "";
      for (let i = 0; i < strHex.length; i += 2) {
        const charCode = parseInt(strHex.substr(i, 2), 16);
        if (charCode !== 0) reason += String.fromCharCode(charCode);
      }
      const cleanReason = reason.trim();
      return {
        type: "Error(string)",
        selector: "0x08c379a0",
        name: "StandardError",
        message: cleanReason || "Empty Error(string) payload",
        category: "SolidityError"
      };
    } catch {
      return {
        type: "Error(string)",
        selector: "0x08c379a0",
        name: "StandardError",
        message: "Failed parsing Error(string) UTF-8 characters",
        category: "SolidityError"
      };
    }
  }

  // 2. Panic(uint256) -> 0x4e487b71
  if (selector === "0x4e487b71" && cleanData.length >= 74) {
    const code = parseInt(cleanData.slice(10, 74), 16);
    const explanation = PANIC_CODES[code] || `Compiler Panic code 0x${code.toString(16)}`;
    return {
      type: "Panic(uint256)",
      selector: "0x4e487b71",
      code,
      name: `Panic(0x${code.toString(16).padStart(2, "0")})`,
      message: explanation,
      category: "CompilerPanic"
    };
  }

  // 3. Known Custom Errors
  if (KNOWN_CUSTOM_ERRORS[selector]) {
    const info = KNOWN_CUSTOM_ERRORS[selector];
    return {
      type: "CustomError",
      selector,
      name: info.name,
      signature: info.signature,
      message: `${info.name} — ${info.description}`,
      category: info.category
    };
  }

  // 4. Unknown Custom Error
  //
  // This is the common case on a live chain: most contracts ship errors that no
  // public catalog knows. Saying only "unknown selector" leaves the user with
  // nothing, so the argument words are decoded structurally. They are labelled
  // as words, never as named parameters, because the ABI is what gives a
  // parameter its meaning and we do not have it.
  const args = decodeErrorWords(cleanData);
  return {
    type: "CustomError(Unknown)",
    selector,
    name: `Custom_${selector}`,
    signature: null,
    message: args.length === 0
      ? `Custom Solidity contract error with 4-byte selector ${selector} and no argument data. The contract's ABI is required to name this error.`
      : `Custom Solidity contract error with 4-byte selector ${selector}, ${args.length} argument word(s): ${args
          .map((a) => a.asUint)
          .join(", ")}. The contract's ABI is required to name this error.`,
    args,
    category: "UnknownCustom"
  };
}

/**
 * Split the argument payload of a custom error into 32-byte words.
 * Purely structural: "this word is 349412591" is a fact, "this word is
 * amountOutMin" is a guess we cannot make without the ABI.
 */
export function decodeErrorWords(cleanData) {
  const body = cleanData.slice(10);
  const words = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    const hex = body.slice(i, i + 64);
    const asUint = BigInt(`0x${hex}`).toString(10);
    // No address guessing here. A left-padded 20-byte word and a small integer
    // are the same 32 bytes, so "this is an address" would be a coin flip
    // presented as a fact.
    words.push({ index: words.length, word: `0x${hex}`, asUint });
  }
  return words;
}

/**
 * Generate actionable remediation steps based on failure cause
 * @param {object} diagnostic Diagnostic summary object
 * @returns {Array<string>} Step-by-step remediation advice
 */
export function generateRemediationSteps(diagnostic) {
  const steps = [];
  const status = diagnostic.status;
  const reason = (diagnostic.revertReason || diagnostic.diagnosis || "").toLowerCase();
  const revType = diagnostic.revertType || "";

  if (status === "OUT_OF_GAS") {
    steps.push("Increase transaction gasLimit in wallet (e.g. 1.5x–2x current limit).");
    steps.push("Verify target contract does not contain infinite loops or unbounded arrays in storage.");
    steps.push("Check if contract execution requires complex state initialization.");
    return steps;
  }

  if (status === "PENDING_OR_DROPPED") {
    steps.push("Check if transaction nonce was replaced or cancelled with higher gas fee.");
    steps.push("Verify node RPC mempool connectivity via Pacific Mainnet RPC (https://pacific-rpc.pharos.xyz).");
    return steps;
  }

  if (status === "SUCCESS") {
    steps.push("No fix needed. Transaction was mined successfully in block.");
    return steps;
  }

  // Revert reason specific advice
  if (reason.includes("allowance") || diagnostic.errorName?.includes("Allowance")) {
    steps.push("Call approve(spender, amount) on the ERC-20 token contract before submitting this transaction.");
    steps.push("Verify you are approving the exact contract or router performing the transfer.");
    steps.push("Check token decimals (stPROS and USDC have specific decimal precisions).");
  } else if (reason.includes("balance") || diagnostic.errorName?.includes("Balance")) {
    steps.push("Top up wallet native PROS balance or required ERC-20 token balance.");
    steps.push("Ensure you have extra PROS remaining to pay for transaction gas fees.");
  } else if (reason.includes("paused") || diagnostic.errorName?.includes("Pause")) {
    steps.push("The target protocol is currently paused for maintenance or emergency protection.");
    steps.push("Wait for protocol admins to unpause before broadcasting transactions.");
  } else if (reason.includes("deadline") || reason.includes("expired")) {
    steps.push("DEX swap deadline exceeded due to network congestion or delayed signing.");
    steps.push("Re-generate quote with fresh block timestamp and re-submit.");
  } else if (reason.includes("slippage") || reason.includes("amount")) {
    steps.push("Increase slippage tolerance setting in dApp interface (e.g., from 0.5% to 1.0%).");
    steps.push("Market price moved during trade execution.");
  } else if (reason.includes("owner") || reason.includes("unauthorized") || diagnostic.errorName?.includes("Unauthorized")) {
    steps.push("Switch to the designated admin/owner wallet address in your Web3 provider.");
    steps.push("Verify you hold the appropriate AccessControl role (e.g. MINTER_ROLE, OPERATOR_ROLE).");
  } else if (revType === "Panic(uint256)") {
    if (diagnostic.panicCode === 0x11) {
      steps.push("Arithmetic overflow/underflow occurred. Check calculation inputs or uint256 ranges.");
    } else if (diagnostic.panicCode === 0x32) {
      steps.push("Array index out of bounds. Ensure requested item index exists in smart contract list.");
    } else if (diagnostic.panicCode === 0x12) {
      steps.push("Division by zero encountered. Validate divisor arguments.");
    } else {
      steps.push("Internal contract invariant assertion failed. Review contract logic.");
    }
  } else {
    steps.push("Inspect contract ABI and ensure all parameter types match expected types.");
    steps.push("Use Chain MCP / pre-flight dry-run simulator to test transaction execution state before broadcasting.");
  }

  return steps;
}

/**
 * Analyze a transaction failure from tx, receipt, and returnData
 * @param {object} params { tx, receipt, returnData }
 * @returns {object} Comprehensive diagnostic report
 */
/**
 * RPC quantities arrive as hex strings ("0x29095"). The API contract and the
 * browser UI both expect decimal, and live mode was quietly violating that: the
 * dashboard rendered "#0x1514f8a" for the block and "168,085 / 0" for gas,
 * because gasLimit was read from tx.gasLimit while JSON-RPC calls it tx.gas.
 * Normalise in one place rather than in every consumer.
 *
 * @returns {number|null} decimal value, or null when the input is not a number
 */
export function toDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const parsed = /^0x/i.test(trimmed)
    ? Number.parseInt(trimmed, 16)
    : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function analyzeTxFailure({ tx, receipt, returnData }) {
  if (!receipt) {
    return {
      status: "PENDING_OR_DROPPED",
      diagnosis: "Transaction receipt not found or tx dropped from mempool.",
      remediation: "Verify tx hash or re-broadcast with adjusted nonce/gas.",
      steps: generateRemediationSteps({ status: "PENDING_OR_DROPPED" }),
      txHash: tx?.hash || null
    };
  }

  const isSuccess = receipt.status === 1 || receipt.status === "0x1" || receipt.status === true;
  if (isSuccess) {
    return {
      status: "SUCCESS",
      diagnosis: "Transaction succeeded. No failure detected.",
      remediation: "Transaction completed successfully.",
      steps: ["No action required."],
      blockNumber: toDecimal(receipt.blockNumber),
      gasUsed: toDecimal(receipt.gasUsed),
      gasLimit: toDecimal(tx?.gasLimit ?? tx?.gas ?? receipt.gasLimit),
      txHash: receipt.transactionHash
    };
  }

  // Failed status (0 or "0x0")
  // JSON-RPC transactions carry the limit as `gas`, not `gasLimit`. Reading only
  // `gasLimit` meant out-of-gas detection could never fire for a live
  // transaction -- the headline feature was dead in the one mode that matters.
  const gasLimitRaw = tx?.gasLimit ?? tx?.gas ?? receipt.gasLimit;
  const gasUsed = BigInt(toDecimal(receipt.gasUsed) ?? 0);
  const gasLimit = BigInt(toDecimal(gasLimitRaw) ?? 0);

  if (gasLimit > 0n && gasUsed >= gasLimit) {
    const diag = {
      status: "OUT_OF_GAS",
      diagnosis: "Transaction ran out of gas. Gas used reached the transaction gas limit.",
      remediation: "Increase transaction gas limit before re-submitting.",
      gasUsed: toDecimal(receipt.gasUsed),
      gasLimit: toDecimal(gasLimitRaw),
      blockNumber: toDecimal(receipt.blockNumber),
      txHash: receipt.transactionHash
    };
    diag.steps = generateRemediationSteps(diag);
    return diag;
  }

  const revert = decodeRevertReason(returnData || "0x");
  const diag = {
    status: "REVERTED",
    revertType: revert.type,
    errorName: revert.name,
    selector: revert.selector,
    revertReason: revert.message,
    category: revert.category,
    panicCode: revert.code !== undefined ? revert.code : null,
    errorArgs: revert.args || null,
    diagnosis: `Transaction reverted with ${revert.type}: "${revert.message}"`,
    remediation: "Review parameter inputs and preconditions.",
    blockNumber: toDecimal(receipt.blockNumber),
    gasUsed: toDecimal(receipt.gasUsed),
    gasLimit: toDecimal(gasLimitRaw),
    from: tx?.from || receipt.from,
    to: tx?.to || receipt.to,
    txHash: receipt.transactionHash || tx?.hash
  };

  diag.steps = generateRemediationSteps(diag);
  if (diag.steps.length > 0) {
    diag.remediation = diag.steps[0];
  }

  return diag;
}

/**
 * Fetch transaction & receipt from Pharos RPC and perform live diagnostic replay
 * @param {string} txHash 0x-prefixed transaction hash
 * @param {string} rpcUrl JSON-RPC endpoint
 * @returns {Promise<object>} Live analysis result with provenance trace
 */
export async function fetchAndDiagnoseTx(txHash, rpcUrl = DEFAULT_PHAROS_RPC) {
  const auditTrail = [];
  auditTrail.push({ time: new Date().toISOString(), step: "1. Querying Receipt", detail: `Fetching receipt for ${txHash}` });

  // 1. Fetch Receipt
  const receiptRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [txHash]
    })
  });

  const receiptJson = await receiptRes.json();
  // An RPC-level error (rate limit, unsupported method, bad gateway) used to be
  // read as "receipt not found", so the agent told users their transaction had
  // been dropped when in fact the node had refused to answer.
  if (receiptJson.error) {
    throw new Error(`RPC eth_getTransactionReceipt failed: ${receiptJson.error.message || "unknown error"}`);
  }
  const receipt = receiptJson.result;

  if (!receipt) {
    return {
      status: "PENDING_OR_DROPPED",
      diagnosis: "Transaction receipt not found on Pharos RPC. The transaction may be pending, dropped, or invalid hash.",
      steps: ["Confirm transaction hash on https://pharosscan.xyz", "Check if tx is still in mempool"],
      auditTrail
    };
  }

  auditTrail.push({
    time: new Date().toISOString(),
    step: "2. Receipt Evaluated",
    detail: `Status: ${receipt.status}, Block: ${receipt.blockNumber}, Gas Used: ${parseInt(receipt.gasUsed, 16) || receipt.gasUsed}`
  });

  // 2. Fetch Tx details
  const txRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_getTransactionByHash",
      params: [txHash]
    })
  });
  const txJson = await txRes.json();
  if (txJson.error) {
    throw new Error(`RPC eth_getTransactionByHash failed: ${txJson.error.message || "unknown error"}`);
  }
  const tx = txJson.result || {};

  // 3. If failed and no revert string in receipt, run eth_call replay
  let returnData = "0x";
  let replayError = null;
  if (receipt.status === 0 || receipt.status === "0x0") {
    auditTrail.push({
      time: new Date().toISOString(),
      step: "3. Replaying Revert via eth_call",
      detail: `Simulating execution on target ${tx.to} to extract revert bytes`
    });

    try {
      const callRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "eth_call",
          params: [
            {
              from: tx.from,
              to: tx.to,
              data: tx.input,
              value: tx.value
            },
            receipt.blockNumber || "latest"
          ]
        })
      });
      const callJson = await callRes.json();
      if (callJson.error && callJson.error.data) {
        returnData = callJson.error.data;
      } else if (callJson.result) {
        returnData = callJson.result;
      } else if (callJson.error) {
        // The node refused the call. That is not the same as a contract that
        // reverted with no data, and the two need different advice.
        replayError = callJson.error.message || "eth_call returned an error";
      }
    } catch (err) {
      // Swallowing this used to turn "the RPC rate-limited us" into "the
      // contract reverted silently" -- a confident wrong answer.
      replayError = err?.message || String(err);
    }
  }

  auditTrail.push({
    time: new Date().toISOString(),
    step: "4. Decoding Diagnostic Reason",
    detail: `Raw return data: ${returnData.slice(0, 34)}...`
  });

  const analysis = analyzeTxFailure({ tx, receipt, returnData });
  analysis.auditTrail = auditTrail;

  // Only claim "reverted with no data" when the replay actually ran.
  if (replayError && returnData === "0x") {
    analysis.revertDataUnavailable = true;
    analysis.replayError = replayError;
    analysis.steps = [
      `Revert data could not be recovered: ${replayError}`,
      "The transaction did fail (receipt status 0), but the replay did not run, so the reason is unknown rather than empty.",
      ...(analysis.steps || [])
    ];
    auditTrail.push({
      time: new Date().toISOString(),
      step: "3b. Replay Failed",
      detail: replayError
    });
  }
  analysis.network = "Pharos Pacific Mainnet (Chain 1672)";
  analysis.rpcUrl = rpcUrl;
  return analysis;
}

/**
 * Utility helper to build standard revert byte payload for testing/mocking
 */
export function encodeSampleRevert(type, messageOrCode) {
  if (type === "Error(string)") {
    const selector = "08c379a0";
    const offset = "0000000000000000000000000000000000000000000000000000000000000020";
    const msg = String(messageOrCode || "Execution reverted");
    const lenHex = msg.length.toString(16).padStart(64, "0");
    let strHex = "";
    for (let i = 0; i < msg.length; i++) {
      strHex += msg.charCodeAt(i).toString(16).padStart(2, "0");
    }
    const paddedStr = strHex.padEnd(Math.ceil(strHex.length / 64) * 64, "0");
    return `0x${selector}${offset}${lenHex}${paddedStr}`;
  }

  if (type === "Panic(uint256)") {
    const selector = "4e487b71";
    const code = Number(messageOrCode || 1).toString(16).padStart(64, "0");
    return `0x${selector}${code}`;
  }

  return "0x";
}
