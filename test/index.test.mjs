import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  decodeRevertReason,
  analyzeTxFailure,
  generateRemediationSteps,
  encodeSampleRevert,
  PANIC_CODES,
  KNOWN_CUSTOM_ERRORS,
  CUSTOM_ERROR_CATALOG,
  keccak256,
  selectorOf,
  canonicalSignature,
  buildCustomErrorTable,
  decodeErrorWords
} from "../src/diagnostics.mjs";

console.log("🛠️  Running comprehensive test suite for Pharos dApp Support Agent...\n");

// ==========================================
// TEST SUITE 1: Standard Error(string) Decoding
// ==========================================
console.log("▶ Suite 1: Standard Error(string) Decoding (0x08c379a0)");
{
  const revertHex = encodeSampleRevert("Error(string)", "ERC20: transfer amount exceeds balance");
  const dec = decodeRevertReason(revertHex);
  assert.strictEqual(dec.type, "Error(string)");
  assert.strictEqual(dec.selector, "0x08c379a0");
  assert.strictEqual(dec.message, "ERC20: transfer amount exceeds balance");
  assert.strictEqual(dec.category, "SolidityError");

  // Custom string
  const customMsg = "Ownable: caller is not the owner";
  const customHex = encodeSampleRevert("Error(string)", customMsg);
  const customDec = decodeRevertReason(customHex);
  assert.strictEqual(customDec.message, customMsg);
  console.log("  ✔ Decoded standard Error(string) payloads accurately");
}

// ==========================================
// TEST SUITE 2: Compiler Panic(uint256) Codes
// ==========================================
console.log("\n▶ Suite 2: Compiler Panic(uint256) Codes (0x4e487b71)");
{
  // 0x11 -> Arithmetic overflow
  const panic11 = encodeSampleRevert("Panic(uint256)", 0x11);
  const dec11 = decodeRevertReason(panic11);
  assert.strictEqual(dec11.type, "Panic(uint256)");
  assert.strictEqual(dec11.code, 17);
  assert.strictEqual(dec11.message.includes("overflow"), true);

  // 0x32 -> Array index out of bounds
  const panic32 = encodeSampleRevert("Panic(uint256)", 0x32);
  const dec32 = decodeRevertReason(panic32);
  assert.strictEqual(dec32.code, 50);
  assert.strictEqual(dec32.message.includes("bounds"), true);

  // 0x01 -> Assertion failed
  const panic01 = encodeSampleRevert("Panic(uint256)", 0x01);
  const dec01 = decodeRevertReason(panic01);
  assert.strictEqual(dec01.code, 1);
  assert.strictEqual(dec01.message.includes("assert"), true);
  console.log("  ✔ Decoded compiler Panic codes (0x11, 0x32, 0x01) with correct diagnostic messages");
}

// ==========================================
// TEST SUITE 3: Custom Error Selectors
// ==========================================
// These assertions must be computed, not restated. The previous version of this
// suite asserted that 0x8456cb59 was EnforcedPause() -- which is simply false --
// so it passed against a table where 13 of 18 selectors were wrong. A test that
// repeats the implementation's own table can never catch a wrong table.
console.log("\n▶ Suite 3: Selector correctness, verified by hashing");

// 3a. The hash itself, against published vectors.
{
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.strictEqual(
    hex(keccak256(new Uint8Array(0))),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    "keccak256(empty) must match the published digest"
  );
  assert.strictEqual(
    hex(keccak256(new TextEncoder().encode("abc"))),
    "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    "keccak256(\"abc\") must match the published digest"
  );
  console.log("  ✔ keccak256 matches published test vectors (empty, \"abc\")");
}

// 3b. Every selector in the table is the hash of the signature it claims.
{
  const table = buildCustomErrorTable();
  for (const [selector, entry] of Object.entries(KNOWN_CUSTOM_ERRORS)) {
    assert.strictEqual(
      selectorOf(entry.signature),
      selector,
      `${entry.name} is filed under ${selector} but ${entry.signature} hashes to ${selectorOf(entry.signature)}`
    );
    assert.strictEqual(table[selector].signature, entry.signature);
  }
  assert.strictEqual(Object.keys(KNOWN_CUSTOM_ERRORS).length, CUSTOM_ERROR_CATALOG.length);
  console.log(`  ✔ All ${CUSTOM_ERROR_CATALOG.length} selectors are the hash of their own signature`);
}

// 3c. Selectors that were previously mislabelled, pinned explicitly. If someone
// reintroduces a hand-written table, these fail on the exact real-world cases.
{
  const expected = {
    "EnforcedPause()": "0xd93c0665",
    "ExpectedPause()": "0x8dfc202b",
    "SlippageExceeded()": "0x8199f5f3",
    "DeadlineExpired()": "0x1ab7da6b",
    "TransferFailed()": "0x90b8ec18",
    "InvalidAmount()": "0x2c5211c6",
    "ReentrancyGuardReentrantCall()": "0x3ee5aeb5",
    "OwnableUnauthorizedAccount(address)": "0x118cdaa7",
    "OwnableInvalidOwner(address)": "0x1e4fbdf7",
    "ERC20InvalidApprover(address)": "0xe602df05",
    "ERC20InvalidSpender(address)": "0x94280d62",
    "ERC20InvalidSender(address)": "0x96c6fd1e",
    "ERC20InvalidReceiver(address)": "0xec442f05"
  };
  for (const [signature, selector] of Object.entries(expected)) {
    assert.strictEqual(selectorOf(signature), selector, `${signature} selector drifted`);
    assert.ok(KNOWN_CUSTOM_ERRORS[selector], `${signature} missing from the table`);
  }
  // And the old wrong pairings must be gone.
  assert.notStrictEqual(KNOWN_CUSTOM_ERRORS["0x8456cb59"]?.name, "EnforcedPause");
  assert.notStrictEqual(KNOWN_CUSTOM_ERRORS["0x1f2a2005"]?.name, "OwnableUnauthorizedAccount");
  assert.notStrictEqual(KNOWN_CUSTOM_ERRORS["0xbb55fd27"]?.name, "SlippageExceeded");
  console.log("  ✔ 13 previously wrong mappings pinned, 3 old mistakes proven absent");
}

// 3d. Decoding a real-world selector names the right error.
{
  const pause = decodeRevertReason(selectorOf("EnforcedPause()"));
  assert.strictEqual(pause.name, "EnforcedPause");
  assert.strictEqual(pause.category, "Lifecycle");
  assert.strictEqual(pause.type, "CustomError");

  const unauth = decodeRevertReason(selectorOf("Unauthorized()"));
  assert.strictEqual(unauth.name, "Unauthorized");

  const slip = decodeRevertReason(selectorOf("SlippageExceeded()"));
  assert.strictEqual(slip.name, "SlippageExceeded");
  assert.strictEqual(slip.category, "DEX/DeFi");

  const allowance = decodeRevertReason(
    selectorOf("ERC20InsufficientAllowance(address,uint256,uint256)") + "00".repeat(96)
  );
  assert.strictEqual(allowance.name, "ERC20InsufficientAllowance");

  const unknown = decodeRevertReason("0x12345678");
  assert.strictEqual(unknown.type, "CustomError(Unknown)");
  assert.strictEqual(unknown.selector, "0x12345678");
  console.log("  ✔ Selectors name the correct error, unknown selectors stay unknown");
}

// 3e. Parameter names must not change the hash -- the ABI canonical form drops
// them, and contracts are often compiled from sources that include them.
{
  assert.strictEqual(
    selectorOf("transfer(address to, uint256 amount)"),
    selectorOf("transfer(address,uint256)")
  );
  assert.strictEqual(canonicalSignature("transfer(address to, uint256 amount)"), "transfer(address,uint256)");
  assert.strictEqual(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  console.log("  ✔ Parameter names in a signature do not affect the selector");
}

// ==========================================
// TEST SUITE 4: Out of Gas Failure Detection
// ==========================================
console.log("\n▶ Suite 4: Resource Limits & Out-of-Gas Detection");
{
  const oogAnalysis = analyzeTxFailure({
    tx: { gasLimit: "80000" },
    receipt: { status: 0, gasUsed: "80000", blockNumber: 55432, transactionHash: "0xdeadbeef" },
    returnData: "0x"
  });

  assert.strictEqual(oogAnalysis.status, "OUT_OF_GAS");
  assert.strictEqual(oogAnalysis.diagnosis.includes("out of gas"), true);
  assert.strictEqual(oogAnalysis.steps.some(s => s.toLowerCase().includes("gaslimit")), true);
  console.log("  ✔ Accurately flagged Out-of-Gas when gasUsed matches gasLimit");
}

// ==========================================
// TEST SUITE 5: Actionable Remediation Advice
// ==========================================
console.log("\n▶ Suite 5: Actionable Remediation Engine");
{
  // Allowance error remediation
  const allowDiag = analyzeTxFailure({
    tx: { gasLimit: "100000" },
    receipt: { status: 0, gasUsed: "32000", blockNumber: 100 },
    returnData: encodeSampleRevert("Error(string)", "ERC20: insufficient allowance")
  });
  assert.strictEqual(allowDiag.remediation.toLowerCase().includes("approve"), true);

  // Balance error remediation
  const balDiag = analyzeTxFailure({
    tx: { gasLimit: "100000" },
    receipt: { status: 0, gasUsed: "32000", blockNumber: 100 },
    returnData: encodeSampleRevert("Error(string)", "ERC20: transfer amount exceeds balance")
  });
  assert.strictEqual(balDiag.remediation.toLowerCase().includes("balance"), true);

  // Paused contract remediation
  const pauseDiag = analyzeTxFailure({
    tx: { gasLimit: "100000" },
    receipt: { status: 0, gasUsed: "25000", blockNumber: 100 },
    returnData: selectorOf("EnforcedPause()")
  });
  assert.strictEqual(pauseDiag.remediation.toLowerCase().includes("pause"), true);
  console.log("  ✔ Generated targeted, step-by-step developer remediation actions for all failure causes");
}

// ==========================================
// TEST SUITE 6: Success & Non-reverted States
// ==========================================
console.log("\n▶ Suite 6: Succeeded and Pending/Dropped States");
{
  const successAnalysis = analyzeTxFailure({
    receipt: { status: 1, gasUsed: "21000", blockNumber: 99999, transactionHash: "0xsuccess" }
  });
  assert.strictEqual(successAnalysis.status, "SUCCESS");

  const pendingAnalysis = analyzeTxFailure({
    receipt: null,
    tx: { hash: "0xpending" }
  });
  assert.strictEqual(pendingAnalysis.status, "PENDING_OR_DROPPED");
  console.log("  ✔ Successfully handled successful transactions (status 1) and dropped/pending receipts");
}

// ==========================================
// TEST SUITE 7: Bundle integrity
// ==========================================
// public/diagnostics.mjs is what the browser actually runs; src/ is what the
// Pages Function runs. They are the same file by contract, so a hand copy that
// drifts would make the UI and the API disagree about the same transaction.
console.log("\n▶ Suite 7: Browser bundle matches the source module");
{
  const here = new URL("../", import.meta.url);
  const src = readFileSync(new URL("src/diagnostics.mjs", here), "utf8");
  const pub = readFileSync(new URL("public/diagnostics.mjs", here), "utf8");
  assert.strictEqual(
    pub,
    src,
    "public/diagnostics.mjs must be a byte-identical copy of src/diagnostics.mjs (run: cp src/diagnostics.mjs public/diagnostics.mjs)"
  );
  // The module has to run in a browser: no Node globals.
  assert.ok(!/\bBuffer\s*[.(]/.test(src), "diagnostics.mjs must not depend on Node's Buffer");
  assert.ok(!/require\(/.test(src), "diagnostics.mjs must stay pure ESM");
  assert.ok(!/from "node:/.test(src), "diagnostics.mjs must not import Node builtins");
  console.log("  ✔ Byte-identical copy, no Node-only globals");

  // The presets used to hardcode 0x8456cb59 and 0xbb55fd27, neither of which is
  // a real selector, so the UI's own demo buttons rendered "unknown custom
  // error". Any 4-byte literal in the browser bundle must name a real error.
  const app = readFileSync(new URL("public/app.js", here), "utf8");
  const STANDARD = new Set(["0x08c379a0", "0x4e487b71"]);
  const literals = [...app.matchAll(/"(0x[0-9a-fA-F]{8})"/g)].map((m) => m[1].toLowerCase());
  for (const literal of literals) {
    assert.ok(
      STANDARD.has(literal) || KNOWN_CUSTOM_ERRORS[literal],
      `public/app.js hardcodes ${literal}, which is not a known error selector`
    );
  }
  console.log(`  ✔ ${literals.length} hardcoded selector(s) in app.js all resolve to real errors`);
}

// ============================================================================
// SUITE: unknown custom errors still carry usable structure
// ============================================================================
console.log("\n▶ Suite: unknown custom-error argument decoding");

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const payload = (sel, ...words) => `0x${sel}${words.join("")}`;

const twoArgs = decodeErrorWords(payload("2c19b8b8", word(350100207), word(350112364)));
assert.strictEqual(twoArgs.length, 2);
assert.strictEqual(twoArgs[0].asUint, "350100207");
assert.strictEqual(twoArgs[1].asUint, "350112364");
assert.strictEqual(twoArgs[0].word.length, 66);
assert.strictEqual(twoArgs[0].index, 0);
console.log("  ✔ two uint words decode to decimal");

// A word that could be either a padded address or an integer must not be
// labelled: the schema carries the raw word so a human can decide.
const ambiguous = decodeErrorWords(payload("2c19b8b8", "0".repeat(24) + "ab".repeat(20)));
assert.strictEqual(ambiguous[0].word, "0x" + "0".repeat(24) + "ab".repeat(20));
assert.strictEqual(ambiguous[0].asAddress, undefined);
console.log("  ✔ ambiguous words stay unlabelled rather than guessed");

assert.deepStrictEqual(decodeErrorWords("0x2c19b8b8"), []);
assert.deepStrictEqual(decodeErrorWords("0x2c19b8b8" + "00".repeat(31)), [], "partial word is dropped");
console.log("  ✔ empty and partial payloads yield no words");

const unknown = decodeRevertReason(payload("2c19b8b8", word(350100207), word(350112364)));
assert.strictEqual(unknown.type, "CustomError(Unknown)");
assert.strictEqual(unknown.name, "Custom_0x2c19b8b8");
assert.match(unknown.message, /350100207/);
assert.match(unknown.message, /ABI/);
assert.strictEqual(unknown.args.length, 2);
console.log("  ✔ an unknown selector reports its words and admits the ABI is missing");

console.log("\n=======================================================");
console.log("🎉 ALL 7 dApp Support Agent TEST SUITES PASSED (100%)");
console.log("=======================================================\n");
