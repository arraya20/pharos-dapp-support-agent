# SKILL: Pharos dApp Support Agent

## Overview

Diagnose failed EVM transactions on **Pharos Pacific Mainnet (Chain ID 1672)**. Takes a
transaction hash or raw revert bytes, recovers the revert reason, classifies the failure, and
produces remediation steps.

## Skill Metadata

- **Skill Name:** `pharos-dapp-support-agent`
- **Domain:** Support & Diagnostics
- **Chain:** Pharos Pacific Mainnet, chain ID 1672 (`eth_chainId` → `0x688`)
- **RPC Endpoint:** `https://rpc.pharos.xyz` — this is the only verified host.
  `pacific-rpc.pharos.xyz` has no A record and will fail with `ENOTFOUND`.
- **Transport:** Pure ESM module + Cloudflare Pages Function (`/api/diagnose`). No runtime
  dependencies, no `ethers`, no `viem`.

**Testnet is not claimed here.** The Atlantic testnet chain ID and RPC host were never verified
from this codebase, so this skill does not assert them. Verify before adding.

## What it decodes

### 1. `Error(string)` — `0x08c379a0`

Length-prefixed UTF-8 reason strings, including custom `require` messages from any dApp.

### 2. `Panic(uint256)` — `0x4e487b71`

<!-- BEGIN GENERATED SELECTORS -->
### Compiler `Panic(uint256)` codes

- `0x00`: Generic compiler panic / unknown
- `0x01`: Assertion failed (assert(false))
- `0x11`: Arithmetic operation underflowed or overflowed outside unchecked block
- `0x12`: Division or modulo by zero (e.g. 5 / 0 or 5 % 0)
- `0x21`: Conversion into an out-of-bounds or invalid enum value
- `0x22`: Storage byte array encoded incorrectly / invalid length prefix
- `0x31`: Array .pop() called on an empty array
- `0x32`: Array or slice index out of bounds access
- `0x41`: Out of memory / excessive memory allocation
- `0x51`: Called uninitialized internal function pointer

### Custom errors

Every selector below is the first four bytes of `keccak256(signature)`,
computed at load time from the signature in the table. Re-derive with
`node scripts/gen-skill-table.mjs`; do not type selectors by hand.

| Selector | Signature | Category |
| --- | --- | --- |
| `0x6697b232` | `AccessControlBadConfirmation()` | AccessControl |
| `0xe2517d3f` | `AccessControlUnauthorizedAccount(address,bytes32)` | AccessControl |
| `0x1ab7da6b` | `DeadlineExpired()` | DEX/DeFi |
| `0xd93c0665` | `EnforcedPause()` | Lifecycle |
| `0x03dee4c5` | `ERC1155InsufficientBalance(address,uint256,uint256,uint256)` | ERC-1155 |
| `0xfb8f41b2` | `ERC20InsufficientAllowance(address,uint256,uint256)` | ERC-20 |
| `0xe450d38c` | `ERC20InsufficientBalance(address,uint256,uint256)` | ERC-20 |
| `0xe602df05` | `ERC20InvalidApprover(address)` | ERC-20 |
| `0xec442f05` | `ERC20InvalidReceiver(address)` | ERC-20 |
| `0x96c6fd1e` | `ERC20InvalidSender(address)` | ERC-20 |
| `0x94280d62` | `ERC20InvalidSpender(address)` | ERC-20 |
| `0x7e273289` | `ERC721NonexistentToken(uint256)` | ERC-721 |
| `0x8dfc202b` | `ExpectedPause()` | Lifecycle |
| `0x2c5211c6` | `InvalidAmount()` | Validation |
| `0x48f5c3ed` | `InvalidCaller()` | AccessControl |
| `0x1e4fbdf7` | `OwnableInvalidOwner(address)` | AccessControl |
| `0x118cdaa7` | `OwnableUnauthorizedAccount(address)` | AccessControl |
| `0x3ee5aeb5` | `ReentrancyGuardReentrantCall()` | Security |
| `0x5274afe7` | `SafeERC20FailedOperation(address)` | ERC-20 |
| `0x8199f5f3` | `SlippageExceeded()` | DEX/DeFi |
| `0x90b8ec18` | `TransferFailed()` | DeFi |
| `0x82b42900` | `Unauthorized()` | AccessControl |
| `0xd92e233d` | `ZeroAddress()` | Validation |

Total: 23 custom errors, 10 panic codes.
<!-- END GENERATED SELECTORS -->

`node scripts/gen-skill-table.mjs --check` fails when this block drifts from the decoder, and
the test suite runs that check.

### 3. Unknown custom errors

A selector outside the table is **not** guessed. The decoder reports the selector, the number of
32-byte argument words, and each word as an unsigned integer. It does not invent names or label a
word as an address: a left-padded integer looks exactly like a left-padded address, and guessing
has produced confident wrong answers before. Naming an unknown selector requires the contract's
own ABI from the explorer — not a public 4-byte database, which is full of collisions.

### 4. Out-of-gas

Compares gas used against the transaction gas limit: `tx.gasLimit ?? tx.gas ?? receipt.gasLimit`.
The `tx.gas` fallback matters — JSON-RPC names the limit `gas`, and reading only `gasLimit`
meant this check silently never fired on live transactions.

## Modes and their honest limits

| Mode | Input | Notes |
| --- | --- | --- |
| Revert bytes | raw hex + gas numbers | Deterministic, no network. The UI presets run here. |
| Live transaction | tx hash | Needs `eth_getTransactionReceipt`, `eth_getTransactionByHash`, and an `eth_call` replay. |

`eth_call` replay against a historical block requires the node to hold state at that block. On a
pruned node the replay fails; when that happens the report says **the reason could not be
recovered**, rather than presenting an empty revert as the answer. Those are different facts.

## Failure behaviour

- RPC-level errors (rate limit, unsupported method, bad gateway) are surfaced as errors. They are
  never converted into "transaction dropped" — the node refusing to answer is not evidence about
  the transaction.
- Malformed request bodies return 400. Only genuine upstream failures return 502.
- If the diagnostic API fails, the UI reports the error and hides the result panel. It does not
  fall back to a sample diagnosis.

## API

`GET /api/diagnose?txHash=0x…` or `?revertHex=0x…[&gasUsed=&gasLimit=]`
`POST /api/diagnose` with JSON `{ txHash }` or `{ tx, receipt, returnData }`

`rpcUrl` is accepted only from an allowlist and must be https; the handler will not proxy an
arbitrary URL.

## Agent integration

```json
{
  "name": "diagnose_failed_tx",
  "description": "Diagnose why an EVM transaction failed on Pharos Pacific Mainnet",
  "parameters": {
    "type": "object",
    "properties": {
      "txHash": { "type": "string", "description": "0x-prefixed 32-byte transaction hash" }
    },
    "required": ["txHash"]
  }
}
```

Callers must treat `status: "PENDING_OR_DROPPED"` as *no receipt found*, not as a failed
transaction. The two require different advice.
