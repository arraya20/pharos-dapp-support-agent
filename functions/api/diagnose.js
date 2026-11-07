import {
  analyzeTxFailure,
  fetchAndDiagnoseTx,
  decodeRevertReason,
  DEFAULT_PHAROS_RPC
} from "../../src/diagnostics.mjs";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// Only the endpoints this agent actually documents. An earlier version passed
// the caller's `rpcUrl` straight to fetch(), which on a public endpoint with
// CORS * is an open proxy: anything reachable from the Worker becomes reachable
// from the internet, including cloud metadata at 169.254.169.254 and any
// internal service on the same network.
const ALLOWED_RPC_HOSTS = new Set(["rpc.pharos.xyz"]);

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function resolveRpcUrl(candidate) {
  if (candidate === undefined || candidate === null || candidate === "") {
    return DEFAULT_PHAROS_RPC;
  }
  if (typeof candidate !== "string" || candidate.length > 200) {
    throw new BadRequest("rpcUrl must be a short string");
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new BadRequest("rpcUrl is not a valid absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new BadRequest("rpcUrl must use https");
  }
  if (url.username || url.password) {
    throw new BadRequest("rpcUrl must not embed credentials");
  }
  if (!ALLOWED_RPC_HOSTS.has(url.hostname.toLowerCase())) {
    throw new BadRequest(
      `rpcUrl host is not allowed; supported: ${[...ALLOWED_RPC_HOSTS].join(", ")}`
    );
  }
  return url.toString();
}

// Chain MCP is the default data source. A caller who names an rpcUrl has asked
// for that node specifically, so only then do we skip MCP. The URL is still
// validated against the allowlist either way.
function liveOptions(rawRpcUrl) {
  const rpcUrl = resolveRpcUrl(rawRpcUrl);
  return rawRpcUrl ? { rpcUrl, transport: "rpc" } : { rpcUrl };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function failure(err) {
  const status = err instanceof BadRequest ? err.status : 502;
  // Do not echo upstream internals on server-side failures.
  const message = err instanceof BadRequest ? err.message : "Upstream RPC request failed";
  return json({ success: false, error: message }, status);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet({ request }) {
  try {
    const url = new URL(request.url);
    const txHash = url.searchParams.get("txHash") || url.searchParams.get("hash");
    const revertHex = url.searchParams.get("revertHex") || url.searchParams.get("hex");
    const live = liveOptions(url.searchParams.get("rpcUrl"));

    if (revertHex) {
      if (!/^0x[0-9a-fA-F]{0,4098}$/.test(revertHex)) {
        throw new BadRequest("revertHex must be a 0x-prefixed hex string");
      }
      return json({ success: true, decoded: decodeRevertReason(revertHex) });
    }

    if (txHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new BadRequest("txHash must be a 32-byte 0x-prefixed hash");
      }
      return json({ success: true, result: await fetchAndDiagnoseTx(txHash, live) });
    }

    return json({
      success: true,
      service: "Pharos dApp Support Agent API",
      network: "Pharos Pacific Mainnet (Chain 1672)",
      dataSource: "Pharos Chain MCP (https://mcp.pharos.xyz/mcp), falling back to https://rpc.pharos.xyz and reporting it in `via`",
      usage: {
        post: "/api/diagnose with body { txHash } or { tx, receipt, returnData }",
        get: "/api/diagnose?txHash=0x... or ?revertHex=0x..."
      }
    });
  } catch (err) {
    return failure(err);
  }
}

export async function onRequestPost({ request }) {
  try {
    // A malformed body is the caller's mistake and must say so. Parsing it
    // inside the outer try meant the SyntaxError fell through to the generic
    // handler and was reported as "Upstream RPC request failed" -- blaming the
    // node for bad JSON, with a 502 instead of a 400.
    let body;
    try {
      body = await request.json();
    } catch {
      throw new BadRequest("body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequest("body must be a JSON object");
    }
    const live = liveOptions(body.rpcUrl);

    if (body.txHash && (!body.receipt || Object.keys(body.receipt).length === 0)) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(body.txHash))) {
        throw new BadRequest("txHash must be a 32-byte 0x-prefixed hash");
      }
      return json({ success: true, result: await fetchAndDiagnoseTx(body.txHash, live) });
    }

    return json({ success: true, result: analyzeTxFailure(body) });
  } catch (err) {
    return failure(err);
  }
}
