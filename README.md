# 🛠️ Pharos dApp Support Agent

[![Pharos Pacific Mainnet](https://img.shields.io/badge/Pharos%20Mainnet-Chain%201672-ff6b35.svg)](https://rpc.pharos.xyz)
[![Pharos Agent Arena](https://img.shields.io/badge/Agent%20Arena-Task%20dapp--support--agent-e11d48.svg)](https://pharos-agent-arena.vercel.app/#tasks)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An autonomous customer and developer support agent that analyzes failed smart contract transactions (`status: 0`), decodes EVM revert bytecode (Standard `Error(string)`, compiler `Panic(uint256)`, OpenZeppelin v5 & DeFi Custom Errors), and synthesizes step-by-step remediation advice for users and protocol developers.

---

## 🌟 Key Features

1. **Comprehensive Revert Bytecode Decoding:**
   - **`0x08c379a0` — `Error(string)`**: Decodes UTF-8 ABI strings (e.g., `ERC20: transfer amount exceeds balance`, `Ownable: caller is not the owner`).
   - **`0x4e487b71` — `Panic(uint256)`**: Full compiler panic mapping (`0x11` Overflow/Underflow, `0x12` Division by Zero, `0x32` Index out of bounds, `0x01` Assert failure).
   - **Custom Errors (4-Byte Selectors)**: 23 signatures covering OpenZeppelin v5 (`ERC20InsufficientBalance`, `ERC20InsufficientAllowance`, `OwnableUnauthorizedAccount`, `EnforcedPause`, `ReentrancyGuardReentrantCall`, `SafeERC20FailedOperation`), AccessControl, ERC721/ERC1155 and common DeFi errors (`SlippageExceeded`, `DeadlineExpired`, `TransferFailed`).
   - Selectors are **not typed by hand**. `src/diagnostics.mjs` carries a keccak-256 implementation and hashes the signature strings at load, so a selector cannot disagree with the error it names. A hand-written table of 18 selectors previously had 13 of them attached to the wrong error.
   - **Unrecognised custom errors are still useful**: the argument words are decoded as words (decimal + raw hex) instead of the error being reported as an opaque selector. No parameter names are invented, because naming them requires the contract ABI.
2. **Resource & Gas Limit Diagnostics:**
   - Flags out-of-gas events when `gasUsed >= gasLimit` with tailored recommendations.
3. **Live On-Chain Simulation Replay:**
   - Fetches transaction receipts and re-simulates failed calls against Pharos Pacific Mainnet RPC (`https://rpc.pharos.xyz`, chain id 1672) via `eth_call` at the failed transaction's block height.
   - A missing receipt, an RPC error and a pending transaction are three different answers. An RPC-level error is surfaced as a failure; it is never reported as "transaction dropped".
   - Requests time out after 10s. The public endpoint enforces a compute-unit rate limit (`cu limit exceeded; Request too fast per second`), so callers should not batch aggressively.
4. **Actionable Remediation Engine:**
   - Outputs clear, non-technical instructions for end-users as well as technical fixes for Solidity developers.
5. **Cyberpunk Web UI & Cloudflare Serverless Function:**
   - Interactive diagnostic dashboard with instant failure presets, live execution provenance, copyable JSON & Markdown reports, and `/api/diagnose` endpoint.

---

## 🚀 Quick Start

### 1. Run Automated Tests
```bash
npm test              # offline: decoder suites + API handler (16 cases)
npm run test:live     # opt-in, hits Pharos mainnet against pinned real txs
```

### 2. Run Local Web Dashboard
```bash
npx wrangler pages dev public
# or
python3 -m http.server 3000 --directory public
```
Open [http://localhost:3000](http://localhost:3000) to test failure scenarios.

### 3. Deploy to Cloudflare Pages
```bash
npx wrangler pages deploy public --project-name pharos-dapp-support-agent
```

---

## 📡 Serverless API Usage

### Request rules

`rpcUrl` is optional and restricted to an allowlist (`rpc.pharos.xyz`), `https` only, no embedded credentials. Anything else is a `400`. Earlier this parameter was passed straight into `fetch()`, which made a public endpoint with `Access-Control-Allow-Origin: *` into an open proxy — including cloud metadata at `169.254.169.254`.

`txHash` must be 32 bytes, `revertHex` must be hex. Upstream failures return `502` with a fixed message and never echo the internal error.

### POST `/api/diagnose`
```json
{
  "tx": { "gasLimit": "100000" },
  "receipt": {
    "status": 0,
    "gasUsed": "45200",
    "blockNumber": 981245,
    "transactionHash": "0xsample"
  },
  "returnData": "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002a45524332303a207472616e7366657220616d6f756e7420657863656564732062616c616e63650000000000000000000000000000000000000000000000000000"
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "status": "REVERTED",
    "revertType": "Error(string)",
    "selector": "0x08c379a0",
    "revertReason": "ERC20: transfer amount exceeds balance",
    "category": "SolidityError",
    "remediation": "Top up wallet native PROS balance or required ERC-20 token balance.",
    "steps": [
      "Top up wallet native PROS balance or required ERC-20 token balance.",
      "Ensure you have extra PROS remaining to pay for transaction gas fees."
    ],
    "gasUsed": "45200",
    "gasLimit": "100000",
    "blockNumber": 981245
  }
}
```

---

## 🧪 Verification

Everything below was produced by running the code, not by inspection.

| Check | Result |
| --- | --- |
| `npm test` | 7 decoder suites + 16 API cases, 0 failures |
| `npm run test:live` | 5/5 against Pharos mainnet |
| Real failed tx | `0x1746ea12…ab08` block 22,105,994 → `REVERTED`, selector `0x2c19b8b8`, 2 argument words |
| Real successful tx | `0xa1c43760…6bab` → `SUCCESS` |
| Endpoint | `rpc.pharos.xyz` answers `eth_chainId` = `0x688` (1672) |
| UI | live mode exercised in a browser: selector, argument words and audit trail render |

## 🏆 Pharos Agent Arena Submission Proof

- **Task Name:** `dapp-support-agent` (Support / Reporting)
- **Status:** Working, tested against mainnet data; not yet deployed
- **Live Demo:** not deployed. The previous README named `https://pharos-dapp-support-agent.pages.dev`, which does not resolve; run `npm run deploy` to create it, then put the real URL here.
- **Repository:** `/home/ubuntu/dapp-support-agent`
