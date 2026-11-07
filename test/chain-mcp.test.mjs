// Offline tests for the Chain MCP data path. A mock server stands in for
// https://mcp.pharos.xyz/mcp and enforces what the real one enforces: a call
// without a session obtained from `initialize` is refused.
import assert from "node:assert";
import { fetchAndDiagnoseTx, encodeSampleRevert } from "../src/diagnostics.mjs";
import { createChainMcpTransport, McpTransportError, CHAIN_MCP_URL } from "../src/chain-mcp.mjs";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.stack || err.message}`);
    failed++;
  }
}

const HASH = "0x" + "ab".repeat(32);
const RPC = "https://rpc.pharos.xyz";
const FROM = "0x" + "11".repeat(20);
const TO = "0x" + "22".repeat(20);

const TX = { from: FROM, to: TO, input: "0xdeadbeef", value: "0x0", gas: "0x186a0", hash: HASH };
const FAILED_RECEIPT = { status: "0x0", gasUsed: "0x5208", blockNumber: "0x10", transactionHash: HASH };

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });
const sse = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;

/**
 * @param {object} cfg
 * @param {(tool:string,args:object)=>object|null} cfg.tools  tool name -> MCP result (or throws)
 * @param {boolean} [cfg.down]       MCP host refuses connections
 * @param {number} [cfg.httpStatus]  MCP host answers this HTTP status
 * @param {(method:string,params:any[])=>object} [cfg.rpc]  direct RPC handler
 */
function mockNetwork({ tools = () => null, down = false, httpStatus = 200, rpc = null } = {}) {
  const log = { mcp: [], rpc: [], sessions: 0 };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).startsWith("https://mcp.")) {
      if (down) throw new Error("connect ECONNREFUSED");
      log.mcp.push(body.method === "tools/call" ? `tools/call:${body.params.name}` : body.method);
      if (httpStatus !== 200) return new Response("nope", { status: httpStatus });
      if (body.method === "initialize") {
        log.sessions++;
        return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }), {
          status: 200,
          headers: { "mcp-session-id": "sess-1", "content-type": "text/event-stream" }
        });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      if (init.headers["mcp-session-id"] !== "sess-1") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Server not initialized" }, id: null }),
          { status: 400 }
        );
      }
      const result = tools(body.params.name, body.params.arguments);
      return new Response(sse({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    }
    // direct RPC
    log.rpc.push(body.method);
    if (!rpc) throw new Error("unexpected direct RPC call: " + body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...rpc(body.method, body.params) }), { status: 200 });
  };
  return { fetchImpl, log };
}

const revertTools = (revertData) => (name, args) => {
  if (name === "get_transaction_receipt") return text(FAILED_RECEIPT);
  if (name === "get_transaction") return text(TX);
  if (name === "eth_call") {
    return {
      isError: true,
      ...text({ error: { message: "execution reverted: ", code: 3, data: revertData } })
    };
  }
  throw new Error("unexpected tool " + name);
};

console.log("\n▶ Chain MCP: primary data path");

await check("diagnoses a failed tx entirely over Chain MCP (initialize → receipt → tx → eth_call)", async () => {
  const revert = encodeSampleRevert("Error(string)", "ERC20: transfer amount exceeds balance");
  const { fetchImpl, log } = mockNetwork({ tools: revertTools(revert) });
  const out = await fetchAndDiagnoseTx(HASH, { fetchImpl });
  assert.strictEqual(out.status, "REVERTED");
  assert.strictEqual(out.revertReason, "ERC20: transfer amount exceeds balance");
  assert.strictEqual(out.via, "chain-mcp");
  assert.strictEqual(out.endpoint, CHAIN_MCP_URL);
  assert.strictEqual(out.mcpFallbackReason, undefined);
  assert.deepStrictEqual(log.mcp, [
    "initialize",
    "notifications/initialized",
    "tools/call:get_transaction_receipt",
    "tools/call:get_transaction",
    "tools/call:eth_call"
  ]);
  assert.strictEqual(log.rpc.length, 0, "no direct RPC when MCP works");
  assert.strictEqual(log.sessions, 1, "one session per diagnosis");
  assert.match(out.auditTrail[0].detail, /chain-mcp/);
});

await check("eth_call is sent in the tool's {transaction, block} shape, pinned to the failed block", async () => {
  let seen;
  const tools = (name, args) => {
    if (name === "eth_call") seen = args;
    return revertTools("0x")(name, args);
  };
  const { fetchImpl } = mockNetwork({ tools });
  await fetchAndDiagnoseTx(HASH, { fetchImpl });
  assert.deepStrictEqual(seen, {
    transaction: { from: FROM, to: TO, data: "0xdeadbeef", value: "0x0" },
    block: "0x10"
  });
});

await check("a revert reported by the tool is data, not a reason to fall back to RPC", async () => {
  const { fetchImpl, log } = mockNetwork({ tools: revertTools(encodeSampleRevert("Panic(uint256)", 0x11)) });
  const out = await fetchAndDiagnoseTx(HASH, { fetchImpl });
  assert.strictEqual(out.panicCode, 0x11);
  assert.strictEqual(out.via, "chain-mcp");
  assert.strictEqual(log.rpc.length, 0);
});

await check("an unknown hash is PENDING_OR_DROPPED, reported over Chain MCP", async () => {
  const { fetchImpl } = mockNetwork({ tools: () => text("null") });
  const out = await fetchAndDiagnoseTx(HASH, { fetchImpl });
  assert.strictEqual(out.status, "PENDING_OR_DROPPED");
  assert.strictEqual(out.via, "chain-mcp");
});

await check("a tool error on the receipt is an error, never 'transaction dropped'", async () => {
  const { fetchImpl, log } = mockNetwork({
    tools: () => ({ isError: true, ...text({ error: { message: "rate limit exceeded" } }) })
  });
  await assert.rejects(() => fetchAndDiagnoseTx(HASH, { fetchImpl }), /rate limit exceeded/);
  assert.strictEqual(log.rpc.length, 0);
});

await check("a replay refused by the node reports 'reason unknown', not an empty revert", async () => {
  const tools = (name, args) =>
    name === "eth_call"
      ? { isError: true, ...text({ error: { message: "missing trie node" } }) }
      : revertTools("0x")(name, args);
  const { fetchImpl } = mockNetwork({ tools });
  const out = await fetchAndDiagnoseTx(HASH, { fetchImpl });
  assert.strictEqual(out.revertDataUnavailable, true);
  assert.match(out.replayError, /missing trie node/);
});

console.log("\n▶ Chain MCP: fallback is explicit");

const rpcHandler = (revert) => (method) => {
  if (method === "eth_getTransactionReceipt") return { result: FAILED_RECEIPT };
  if (method === "eth_getTransactionByHash") return { result: TX };
  if (method === "eth_call") return { error: { message: "execution reverted", data: revert } };
  return { error: { message: "unsupported " + method } };
};

await check("MCP unreachable → RPC answers, and the result says so", async () => {
  const revert = encodeSampleRevert("Error(string)", "Ownable: caller is not the owner");
  const { fetchImpl, log } = mockNetwork({ down: true, rpc: rpcHandler(revert) });
  const out = await fetchAndDiagnoseTx(HASH, { fetchImpl });
  assert.strictEqual(out.revertReason, "Ownable: caller is not the owner");
  assert.strictEqual(out.via, "rpc");
  assert.strictEqual(out.endpoint, RPC);
  assert.match(out.mcpFallbackReason, /unreachable/);
  assert.ok(out.auditTrail.some((s) => /Falling Back/.test(s.step)));
  assert.deepStrictEqual(log.rpc, ["eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_call"]);
});

await check("MCP answering HTTP 500 also falls back, with the status in the reason", async () => {
  const { fetchImpl } = mockNetwork({ httpStatus: 500, rpc: rpcHandler("0x") });
  const out = await fetchAndDiagnoseTx(HASH, { fetchImpl });
  assert.strictEqual(out.via, "rpc");
  assert.match(out.mcpFallbackReason, /HTTP 500/);
});

await check("transport 'mcp' never falls back: failure surfaces", async () => {
  const { fetchImpl, log } = mockNetwork({ down: true, rpc: rpcHandler("0x") });
  await assert.rejects(() => fetchAndDiagnoseTx(HASH, { fetchImpl, transport: "mcp" }), McpTransportError);
  assert.strictEqual(log.rpc.length, 0);
});

await check("a legacy string argument is a direct RPC URL and never touches MCP", async () => {
  const realFetch = globalThis.fetch;
  const { fetchImpl, log } = mockNetwork({ rpc: rpcHandler(encodeSampleRevert("Panic(uint256)", 0x12)) });
  globalThis.fetch = fetchImpl;
  try {
    const out = await fetchAndDiagnoseTx(HASH, RPC);
    assert.strictEqual(out.via, "rpc");
    assert.strictEqual(out.panicCode, 0x12);
    assert.strictEqual(log.mcp.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("both MCP and RPC down → the call fails (the API turns this into 502)", async () => {
  const { fetchImpl } = mockNetwork({ down: true, rpc: null });
  await assert.rejects(() => fetchAndDiagnoseTx(HASH, { fetchImpl }), /unexpected direct RPC/);
});

console.log("\n▶ Chain MCP: transport details");

await check("a call without a session is refused by the server, so the transport must handshake first", async () => {
  const { fetchImpl, log } = mockNetwork({ tools: () => text("{}") });
  const t = createChainMcpTransport({ fetchImpl });
  await t.request("eth_getTransactionByHash", [HASH]);
  await t.request("eth_getTransactionByHash", [HASH]);
  assert.strictEqual(log.sessions, 1, "session is reused across calls");
});

await check("plain-JSON (non-SSE) replies are understood too", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const headers = body.method === "initialize" ? { "mcp-session-id": "s" } : {};
    const result = body.method === "tools/call" ? text({ ok: 1 }) : {};
    return new Response(body.id ? JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) : "", { status: 200, headers });
  };
  const t = createChainMcpTransport({ fetchImpl });
  assert.deepStrictEqual(await t.request("eth_getTransactionByHash", [HASH]), { result: { ok: 1 } });
});

await check("a server that issues no session id is a transport failure", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(sse({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200 });
  };
  const t = createChainMcpTransport({ fetchImpl });
  await assert.rejects(() => t.request("eth_getTransactionByHash", [HASH]), McpTransportError);
});

await check("a failed handshake does not poison the next call", async () => {
  let n = 0;
  const good = mockNetwork({ tools: () => text({ ok: 1 }) }).fetchImpl;
  const fetchImpl = async (url, init) => {
    if (n++ === 0) throw new Error("blip");
    return good(url, init);
  };
  const t = createChainMcpTransport({ fetchImpl });
  await assert.rejects(() => t.request("eth_getTransactionByHash", [HASH]), McpTransportError);
  assert.deepStrictEqual(await t.request("eth_getTransactionByHash", [HASH]), { result: { ok: 1 } });
});

await check("a method the transport does not map is a programming error, not a fallback trigger", async () => {
  const t = createChainMcpTransport({ fetchImpl: async () => new Response("") });
  await assert.rejects(() => t.request("eth_sendRawTransaction", ["0x"]), (e) => !(e instanceof McpTransportError));
});

console.log(`\n${failed === 0 ? "🎉" : "❌"} Chain MCP tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
