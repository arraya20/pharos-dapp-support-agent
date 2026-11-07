// Client for the Pharos Chain MCP server (https://docs.pharos.xyz/tooling-and-infrastructure/mcp).
//
// The server speaks streamable HTTP and is *stateful*: every call needs an
// `mcp-session-id` obtained from `initialize`. This module hides that behind a
// transport with one method, `request(method, params)`, which takes a JSON-RPC
// method name and answers in JSON-RPC shape (`{ result }` or `{ error }`). The
// diagnosis code can therefore run unchanged over Chain MCP or over a raw RPC.
//
// Two kinds of failure are kept apart on purpose:
//
//   * the tool ran and reported an error (e.g. `execution reverted`)
//       -> returned as `{ error }`. That is data about the transaction.
//   * the MCP server could not be reached or did not follow the protocol
//       -> thrown as McpTransportError. That says nothing about the
//          transaction, so callers may fall back to another transport, and must
//          say that they did.
//
// No dependencies: one JSON-RPC POST per step, so no MCP SDK is needed.

export const CHAIN_MCP_URL = "https://mcp.pharos.xyz/mcp";
export const MCP_TIMEOUT_MS = 10000;

const PROTOCOL_VERSION = "2025-03-26";

// JSON-RPC method -> Chain MCP tool, and how to build the tool's arguments.
const TOOLS = {
  eth_getTransactionReceipt: {
    tool: "get_transaction_receipt",
    args: ([hash]) => ({ hash })
  },
  eth_getTransactionByHash: {
    tool: "get_transaction",
    args: ([hash]) => ({ hash })
  },
  eth_call: {
    tool: "eth_call",
    args: ([transaction, block]) => {
      const clean = {};
      for (const [key, value] of Object.entries(transaction || {})) {
        if (value !== undefined && value !== null) clean[key] = value;
      }
      return block === undefined ? { transaction: clean } : { transaction: clean, block };
    }
  }
};

export class McpTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpTransportError";
  }
}

// The server answers either with plain JSON or as an SSE stream (`data: {...}`).
function parseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new McpTransportError("Chain MCP returned an empty body");
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to SSE parsing */
    }
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  for (const line of dataLines.reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      /* try the previous event */
    }
  }
  throw new McpTransportError("Chain MCP returned a body that is neither JSON nor SSE");
}

/**
 * @param {object} [opts]
 * @param {string} [opts.url]        MCP endpoint
 * @param {number} [opts.timeoutMs]  per-request timeout
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createChainMcpTransport({
  url = CHAIN_MCP_URL,
  timeoutMs = MCP_TIMEOUT_MS,
  fetchImpl
} = {}) {
  let sessionPromise = null;
  let nextId = 1;
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  async function post(body, sessionId) {
    let res;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new McpTransportError(`Chain MCP unreachable: ${err?.message || err}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new McpTransportError(`Chain MCP answered HTTP ${res.status}`);
    }
    return { res, text };
  }

  function openSession() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const init = await post({
          jsonrpc: "2.0",
          id: nextId++,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "pharos-dapp-support-agent", version: "1.0.0" }
          }
        });
        const sessionId = init.res.headers.get("mcp-session-id");
        const reply = parseBody(init.text);
        if (reply.error) {
          throw new McpTransportError(`Chain MCP initialize failed: ${reply.error.message || "unknown"}`);
        }
        if (!sessionId) throw new McpTransportError("Chain MCP did not issue a session id");
        await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
        return sessionId;
      })();
      // A failed handshake must not poison later calls on the same transport.
      sessionPromise.catch(() => {
        sessionPromise = null;
      });
    }
    return sessionPromise;
  }

  return {
    name: "chain-mcp",
    endpoint: url,

    async request(method, params = []) {
      const mapping = TOOLS[method];
      if (!mapping) throw new Error(`Chain MCP transport does not map ${method}`);

      const sessionId = await openSession();
      const { text } = await post(
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name: mapping.tool, arguments: mapping.args(params) }
        },
        sessionId
      );
      const reply = parseBody(text);
      if (reply.error) {
        // Protocol-level failure (expired session, unknown tool, ...).
        throw new McpTransportError(`Chain MCP ${mapping.tool} failed: ${reply.error.message || "unknown"}`);
      }

      const out = reply.result;
      const payload = out?.content?.find((c) => c.type === "text")?.text;
      if (typeof payload !== "string") {
        throw new McpTransportError(`Chain MCP ${mapping.tool} returned no text content`);
      }

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // Not JSON: e.g. "MCP error -32602: Input validation error ...".
        if (out.isError) return { error: { message: payload } };
        throw new McpTransportError(`Chain MCP ${mapping.tool} returned non-JSON content`);
      }

      if (out.isError) {
        // The tool ran and reported an error; keep message, code and revert data.
        const err = parsed?.error ?? { message: String(payload) };
        return { error: err };
      }
      return { result: parsed };
    }
  };
}

/** Direct JSON-RPC transport: same interface, no MCP. Used as the fallback. */
export function createRpcTransport({ url, timeoutMs = MCP_TIMEOUT_MS, fetchImpl } = {}) {
  let nextId = 1;
  return {
    name: "rpc",
    endpoint: url,
    async request(method, params = []) {
      const res = await (fetchImpl || globalThis.fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
      });
      return res.json();
    }
  };
}
