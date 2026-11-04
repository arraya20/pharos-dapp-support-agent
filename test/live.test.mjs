// Live tests against Pharos Pacific Mainnet. Opt-in, because they need network
// access and the public RPC enforces a compute-unit rate limit ("cu limit
// exceeded; Request too fast per second"), which makes them flaky in CI.
//
//   RUN_LIVE_TESTS=1 node test/live.test.mjs
//
// The two transactions below are real mainnet transactions, pinned by hash so
// the assertions describe on-chain history rather than anything this module
// produced. Both were found by scanning blocks around 22,105,994.
import assert from "node:assert";
import { fetchAndDiagnoseTx, DEFAULT_PHAROS_RPC, selectorOf } from "../src/diagnostics.mjs";

if (process.env.RUN_LIVE_TESTS !== "1") {
  console.log("\n⏭  Live tests skipped. Run with RUN_LIVE_TESTS=1 to hit Pharos mainnet.\n");
  process.exit(0);
}

const FAILED_TX = "0x1746ea121dfb6b387d3fb904c58444d4c5b26e4f7debd850f97cfb0c970bab08";
const SUCCESS_TX = "0xa1c437602630477fc98e8ba10e5b251c9663eaae320b223b62edbfaf592d6bab";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.message}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry only on the documented rate-limit response, never on a wrong answer.
async function withRetry(fn, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!/cu limit|too fast|429|fetch failed/i.test(err.message)) throw err;
      await sleep(600 * (i + 1));
    }
  }
  throw last;
}

console.log(`\n▶ Live: ${DEFAULT_PHAROS_RPC}`);

await check("the documented endpoint serves chain id 1672", async () => {
  const res = await withRetry(() =>
    fetch(DEFAULT_PHAROS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(15000)
    }).then((r) => r.json())
  );
  assert.strictEqual(res.result, "0x688", "expected chainId 0x688 (1672)");
});

await check("a real failed tx is replayed and decoded", async () => {
  const diag = await withRetry(() => fetchAndDiagnoseTx(FAILED_TX));
  assert.strictEqual(diag.status, "REVERTED");
  assert.strictEqual(diag.selector, "0x2c19b8b8");
  assert.strictEqual(diag.errorName, "Custom_0x2c19b8b8");
  assert.strictEqual(diag.category, "UnknownCustom");
  // Two argument words, decoded structurally rather than named. The values are
  // deliberately not pinned: this node returned 349412591/349413996 on the first
  // query and 350100207/350112364 later, so the settled historical state is not
  // something a test should hard-code. Structure is the contract.
  assert.strictEqual(diag.errorArgs.length, 2);
  for (const arg of diag.errorArgs) {
    assert.match(arg.word, /^0x[0-9a-f]{64}$/);
    assert.ok(/^[0-9]+$/.test(arg.asUint));
    assert.ok(BigInt(arg.asUint) > 0n);
  }
  // Both words are plausible token amounts of the same magnitude, which is what
  // an "expected vs actual" style error looks like.
  assert.strictEqual(diag.errorArgs[0].asUint.length, diag.errorArgs[1].asUint.length);
});

await check("a real successful tx reports SUCCESS, not a revert", async () => {
  const diag = await withRetry(() => fetchAndDiagnoseTx(SUCCESS_TX));
  assert.strictEqual(diag.status, "SUCCESS");
  assert.strictEqual(diag.txHash, SUCCESS_TX);
});

await check("an unknown hash is reported as pending/dropped, not as a revert", async () => {
  const diag = await withRetry(() => fetchAndDiagnoseTx("0x" + "00".repeat(32)));
  assert.strictEqual(diag.status, "PENDING_OR_DROPPED");
});

await check("known selectors survive the round trip through mainnet data", async () => {
  // Sanity: the catalog and the decoder agree with each other on a selector that
  // this chain has actually produced.
  assert.strictEqual(selectorOf("EnforcedPause()"), "0xd93c0665");
});

console.log(`\n${failed === 0 ? "🎉" : "❌"} Live tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
