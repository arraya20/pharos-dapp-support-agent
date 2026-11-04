// Tests for the Pages Function. It runs in Node because the handler only needs
// Request/Response/URL, which Node provides -- no wrangler, no network.
import assert from "node:assert";
import { onRequestGet, onRequestPost } from "../functions/api/diagnose.js";
import { selectorOf } from "../src/diagnostics.mjs";

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

const get = (query) => onRequestGet({ request: new Request(`https://agent.test/api/diagnose${query}`) });
const post = (body) =>
  onRequestPost({
    request: new Request("https://agent.test/api/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  });

console.log("\n▶ API: request validation");
console.log("  (no network is used by any case below)");

// The proxy hole: rpcUrl used to go straight into fetch().
const blockedUrls = [
  ["http://pacific-rpc.pharos.xyz", "plain http"],
  ["https://169.254.169.254/latest/meta-data/", "cloud metadata"],
  ["https://127.0.0.1:8545", "loopback"],
  ["https://10.0.0.5", "private range"],
  ["https://evil.example.com", "arbitrary host"],
  ["https://pacific-rpc.pharos.xyz@evil.example.com", "userinfo trick"],
  ["https://user:pass@pacific-rpc.pharos.xyz", "embedded credentials"],
  ["ftp://pacific-rpc.pharos.xyz", "wrong scheme"]
];

for (const [url, label] of blockedUrls) {
  await check(`rejects rpcUrl: ${label}`, async () => {
    const res = await get(`?revertHex=0x08c379a0&rpcUrl=${encodeURIComponent(url)}`);
    const body = await res.json();
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.strictEqual(body.success, false);
    assert.match(body.error, /rpcUrl/);
  });
}

await check("rejects a non-hex revertHex", async () => {
  const res = await get("?revertHex=hello");
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /hex/i);
});

await check("rejects a malformed txHash", async () => {
  const res = await get("?txHash=0x1234");
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /txHash/);
});

await check("rejects a POST without a JSON object body", async () => {
  const res = await onRequestPost({
    request: new Request("https://agent.test/api/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '"just a string"'
    })
  });
  assert.strictEqual(res.status, 400);
});

await check("rejects a POST whose rpcUrl is off the allowlist", async () => {
  const res = await post({ txHash: "0x" + "11".repeat(32), rpcUrl: "https://evil.example.com" });
  assert.strictEqual(res.status, 400);
});

console.log("\n▶ API: decoding path (no upstream call)");

await check("GET revertHex decodes a real selector end to end", async () => {
  const res = await get(`?revertHex=${selectorOf("SlippageExceeded()")}`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.decoded.name, "SlippageExceeded");
  assert.strictEqual(body.decoded.selector, "0x8199f5f3");
});

await check("GET with no arguments returns usage, not an error", async () => {
  const res = await get("");
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.success, true);
  assert.ok(body.usage);
});

await check("POST with an inline tx/receipt does not touch the network", async () => {
  const res = await post({
    tx: { from: "0x" + "aa".repeat(20), to: "0x" + "bb".repeat(20), gasLimit: "0x186a0" },
    receipt: { status: "0x0", gasUsed: "0x5208", blockNumber: "0x10", transactionHash: "0x" + "cc".repeat(32) },
    returnData: selectorOf("EnforcedPause()")
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.result.errorName, "EnforcedPause");
});

const rawPost = (raw) =>
  onRequestPost({
    request: new Request("https://agent.test/api/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw
    })
  });

await check("malformed JSON is a 400, not a blamed RPC", async () => {
  const res = await rawPost("{not json");
  const body = await res.json();
  assert.strictEqual(res.status, 400);
  assert.match(body.error, /valid JSON/);
  assert.ok(!/Upstream/.test(body.error), "bad caller input must not be reported as an upstream failure");
});

await check("a JSON array body is rejected", async () => {
  const res = await rawPost("[1,2,3]");
  assert.strictEqual(res.status, 400);
});

await check("upstream failures are 502 and do not leak internals", async () => {
  // Stub fetch so this suite never touches the network, and so the failure path
  // is exercised deterministically rather than depending on the RPC's mood.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
  };
  try {
    const res = await get("?txHash=0x" + "ab".repeat(32));
    const body = await res.json();
    assert.strictEqual(res.status, 502);
    assert.strictEqual(body.error, "Upstream RPC request failed");
    assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"), "internals must not leak");
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${failed === 0 ? "🎉" : "❌"} API tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
