// Scan recent Pharos mainnet blocks for failed transactions and diagnose a
// spread of them. This is how the demo transactions in the README were found:
// nothing in the evidence is synthetic.
//
//   node scripts/find-failed-txs.mjs [--blocks 2000] [--from latest|<n>] [--max 12]
//
// It reads receipts with eth_getBlockReceipts, keeps the failed ones, then
// diagnoses at most one transaction per (target contract, function selector)
// so the output shows different failures rather than the same bot twelve times.
import { fetchAndDiagnoseTx, DEFAULT_PHAROS_RPC } from "../src/diagnostics.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const BLOCKS = Number(args.blocks || 2000);
const MAX = Number(args.max || 12);
const CONCURRENCY = 2;
const ENOUGH = Number(args.enough || 60); // stop scanning once this many failures are known

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(DEFAULT_PHAROS_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000)
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    if (json && !json.error) return json.result;
    const msg = json?.error?.message || "network error";
    if (!/cu limit|too fast|network/i.test(msg)) throw new Error(`${method}: ${msg}`);
    await sleep(500 * (attempt + 1));
  }
  throw new Error(`${method}: gave up after rate limiting`);
}

const head = parseInt(await rpc("eth_blockNumber", []), 16);
const start = args.from && args.from !== "latest" ? Number(args.from) : head;
console.error(`scanning ${BLOCKS} blocks backwards from ${start}`);

const failed = [];
let cursor = start;
const end = start - BLOCKS;
async function worker() {
  while (cursor > end && failed.length < ENOUGH) {
    const n = cursor--;
    if ((start - n) % 100 === 0) console.error(`  block ${n} · ${failed.length} failed so far`);
    await sleep(150);
    const receipts = await rpc("eth_getBlockReceipts", ["0x" + n.toString(16)]).catch(() => []);
    for (const r of receipts || []) {
      if (r.status === "0x0") failed.push({ hash: r.transactionHash, block: n, to: r.to });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.error(`found ${failed.length} failed transactions`);

// One representative per (to, selector).
const seen = new Set();
const picks = [];
for (const f of failed) {
  const tx = await rpc("eth_getTransactionByHash", [f.hash]);
  const key = `${(tx?.to || "").toLowerCase()}:${(tx?.input || "0x").slice(0, 10)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  picks.push({ ...f, fnSelector: (tx?.input || "0x").slice(0, 10) });
  if (picks.length >= MAX) break;
}

for (const p of picks) {
  try {
    const d = await fetchAndDiagnoseTx(p.hash, { transport: "mcp" });
    console.log(
      JSON.stringify({
        hash: p.hash,
        block: p.block,
        to: p.to,
        calledFunction: p.fnSelector,
        status: d.status,
        revertType: d.revertType,
        selector: d.selector,
        reason: d.revertReason,
        category: d.category,
        gas: `${d.gasUsed}/${d.gasLimit}`,
        via: d.via
      })
    );
  } catch (err) {
    console.log(JSON.stringify({ hash: p.hash, error: err.message }));
  }
  await sleep(300);
}
