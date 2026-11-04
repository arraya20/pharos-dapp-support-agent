# SKILL: Pharos dApp Support Agent

## Overview
An autonomous, zero-dependency customer and developer support agent skill designed for **Pharos Pacific Mainnet (Chain ID 1672)** and **Atlantic Testnet**. It inspects on-chain transaction receipts (status 0), decodes low-level EVM revert bytecodes, determines the precise failure category, and generates step-by-step developer remediation actions.

## Skill Metadata
- **Skill Name:** `pharos-dapp-support-agent`
- **Domain:** Support & Diagnostics / SkillEngine
- **Chain Compatibility:** Pharos Pacific (1672), Atlantic Testnet (688689)
- **RPC Endpoint:** `https://rpc.pharos.xyz` (chain id 1672; `pacific-rpc.pharos.xyz` does not resolve)
- **Transport:** Pure ESM + Cloudflare Pages Functions (`/api/diagnose`)

## Supported Revert Patterns

### 1. Standard Solidity `Error(string)` (`0x08c379a0`)
Extracts length-prefixed ASCII/UTF-8 reason strings including:
- `"ERC20: transfer amount exceeds balance"`
- `"ERC20: insufficient allowance"`
- `"Ownable: caller is not the owner"`
- Custom require strings from dApp contracts

### 2. Solidity Compiler `Panic(uint256)` (`0x4e487b71`)
Decodes internal Solidity assertions and fatal errors:
- `0x01`: Generic compiler assertion failure (`assert(false)`)
- `0x11`: Arithmetic overflow or underflow outside unchecked block
- `0x12`: Division or modulo by zero
- `0x21`: Invalid enum conversion
- `0x22`: Storage byte array encoded incorrectly
- `0x31`: `.pop()` on empty array
- `0x32`: Array or slice index out of bounds
- `0x41`: Out of memory allocation
- `0x51`: Uninitialized internal function pointer call

### 3. OpenZeppelin v5 & DeFi Custom Errors
Matches 4-byte custom error selectors:
- `0xe450d38c`: `ERC20InsufficientBalance(address,uint256,uint256)`
- `0xfb8f41b2`: `ERC20InsufficientAllowance(address,uint256,uint256)`
- `0x1f2a2005`: `OwnableUnauthorizedAccount(address)`
- `0x82b42900`: `Unauthorized()`
- `0x8456cb59`: `EnforcedPause()`
- `0x5bf6f916`: `ReentrancyGuardReentrantCall()`
- `0xbb55fd27`: `SlippageExceeded()`
- `0x3b92ec79`: `DeadlineExpired()`

### 4. Out-of-Gas Failure Detection
Compares `receipt.gasUsed` against `tx.gasLimit`. If `gasUsed >= gasLimit`, categorizes the failure as `OUT_OF_GAS` and instructs the user to increase the gas limit or investigate contract loops.

## AI Agent Integration (MCP Schema)

```json
{
  "name": "diagnose_failed_tx",
  "description": "Diagnose reasons for failed EVM transaction on Pharos Pacific Mainnet",
  "parameters": {
    "type": "object",
    "properties": {
      "txHash": { "type": "string", "description": "0x-prefixed transaction hash" },
      "revertHex": { "type": "string", "description": "Raw return data hex bytes" }
    }
  }
}
```
