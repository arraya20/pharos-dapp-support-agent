import {
  decodeRevertReason,
  analyzeTxFailure,
  encodeSampleRevert,
  KNOWN_CUSTOM_ERRORS,
  PANIC_CODES,
  selectorOf
} from "./diagnostics.mjs";

const PRESETS = {
  erc20_balance: {
    revertHex: encodeSampleRevert("Error(string)", "ERC20: transfer amount exceeds balance"),
    gasLimit: 100000,
    gasUsed: 45200,
    blockNumber: 981245
  },
  erc20_allowance: {
    revertHex: encodeSampleRevert("Error(string)", "ERC20: insufficient allowance"),
    gasLimit: 120000,
    gasUsed: 38400,
    blockNumber: 981246
  },
  panic_overflow: {
    revertHex: "0x4e487b710000000000000000000000000000000000000000000000000000000000000011",
    gasLimit: 150000,
    gasUsed: 54100,
    blockNumber: 981247
  },
  panic_bounds: {
    revertHex: "0x4e487b710000000000000000000000000000000000000000000000000000000000000032",
    gasLimit: 100000,
    gasUsed: 41200,
    blockNumber: 981248
  },
  out_of_gas: {
    revertHex: "0x",
    gasLimit: 60000,
    gasUsed: 60000,
    blockNumber: 981249
  },
  custom_pause: {
    revertHex: selectorOf("EnforcedPause()"),
    gasLimit: 80000,
    gasUsed: 26100,
    blockNumber: 981250
  },
  custom_unauth: {
    revertHex: selectorOf("Unauthorized()"),
    gasLimit: 100000,
    gasUsed: 28900,
    blockNumber: 981251
  },
  custom_slippage: {
    revertHex: selectorOf("SlippageExceeded()"),
    gasLimit: 250000,
    gasUsed: 142000,
    blockNumber: 981252
  }
};

let currentMode = "sim"; // 'sim' | 'rpc'
let lastAnalysisResult = null;

const modeSimBtn = document.getElementById("modeSimBtn");
const modeRpcBtn = document.getElementById("modeRpcBtn");
const presetSection = document.getElementById("presetSection");
const groupTxHash = document.getElementById("groupTxHash");
const groupRevertHex = document.getElementById("groupRevertHex");
const groupGas = document.getElementById("groupGas");

const revertHexInput = document.getElementById("revertHexInput");
const gasLimitInput = document.getElementById("gasLimitInput");
const gasUsedInput = document.getElementById("gasUsedInput");
const txHashInput = document.getElementById("txHashInput");

const diagForm = document.getElementById("diagForm");
const statusIndicator = document.getElementById("statusIndicator");
const loadingState = document.getElementById("loadingState");
const emptyState = document.getElementById("emptyState");
const agentOutput = document.getElementById("agentOutput");

const statusBadge = document.getElementById("statusBadge");
const errorType = document.getElementById("errorType");
const errorSelector = document.getElementById("errorSelector");
const errorCategory = document.getElementById("errorCategory");
const revertReasonText = document.getElementById("revertReasonText");
const remediationList = document.getElementById("remediationList");

const argsRow = document.getElementById("argsRow");
const errorArgsText = document.getElementById("errorArgsText");

const statGas = document.getElementById("statGas");
const statGasPct = document.getElementById("statGasPct");
const statBlock = document.getElementById("statBlock");
const traceList = document.getElementById("traceList");

const btnQuickDecode = document.getElementById("btnQuickDecode");
const btnCopyJson = document.getElementById("btnCopyJson");
const btnCopyMd = document.getElementById("btnCopyMd");

// Mode Switching
modeSimBtn.addEventListener("click", () => {
  currentMode = "sim";
  modeSimBtn.classList.add("active");
  modeRpcBtn.classList.remove("active");
  presetSection.classList.remove("hidden");
  groupRevertHex.classList.remove("hidden");
  groupGas.classList.remove("hidden");
  groupTxHash.classList.add("hidden");
});

modeRpcBtn.addEventListener("click", () => {
  currentMode = "rpc";
  modeRpcBtn.classList.add("active");
  modeSimBtn.classList.remove("active");
  presetSection.classList.add("hidden");
  groupRevertHex.classList.add("hidden");
  groupGas.classList.add("hidden");
  groupTxHash.classList.remove("hidden");
});

// Preset Buttons
document.querySelectorAll(".preset-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const key = btn.dataset.preset;
    const p = PRESETS[key];
    if (p) {
      revertHexInput.value = p.revertHex;
      gasLimitInput.value = p.gasLimit;
      gasUsedInput.value = p.gasUsed;
      executeDiagnosis();
    }
  });
});

diagForm.addEventListener("submit", (e) => {
  e.preventDefault();
  executeDiagnosis();
});

btnQuickDecode.addEventListener("click", () => {
  const hex = revertHexInput.value.trim();
  const decoded = decodeRevertReason(hex);
  alert(`Selector: ${decoded.selector}\nType: ${decoded.type}\nName: ${decoded.name || "N/A"}\nMessage: ${decoded.message}`);
});

async function executeDiagnosis() {
  emptyState.classList.add("hidden");
  agentOutput.classList.add("hidden");
  loadingState.classList.remove("hidden");
  statusIndicator.innerHTML = '<span class="status-pill status-running">Analyzing...</span>';

  try {
    let result;
    if (currentMode === "rpc") {
      const txHash = txHashInput.value.trim();
      // This used to fall back to a made-up diagnosis when the API failed:
      // status REVERTED, "ERC20: transfer amount exceeds balance", 45,200 gas and
      // an audit trail claiming a receipt had been fetched. A support agent that
      // invents an answer when it is broken is worse than one that says it is
      // broken, because the answer looks exactly like a real one.
      const res = await fetch(`/api/diagnose?txHash=${encodeURIComponent(txHash)}`);
      const json = await res.json().catch(() => null);

      if (!res.ok || !json || json.success !== true) {
        throw new Error(
          (json && json.error) || `Diagnostic API returned HTTP ${res.status}. No result was produced.`
        );
      }
      result = json.result;
    } else {
      const revertHex = revertHexInput.value.trim();
      const gasLimit = gasLimitInput.value;
      const gasUsed = gasUsedInput.value;

      result = analyzeTxFailure({
        tx: { gasLimit },
        receipt: {
          status: 0,
          gasUsed,
          gasLimit,
          blockNumber: 981245,
          transactionHash: "0xsample_reverted_tx_hash_pharos_mainnet"
        },
        returnData: revertHex
      });

      result.auditTrail = [
        { time: new Date().toISOString(), step: "1. Receipt Status Checked", detail: `Status 0 (Failed execution), Gas used: ${gasUsed}/${gasLimit}` },
        { time: new Date().toISOString(), step: "2. Calldata / ReturnData Parsed", detail: `Selector ${result.selector || "0x"} evaluated` },
        { time: new Date().toISOString(), step: "3. Remediation Generated", detail: `${result.steps?.length || 1} action items calculated` }
      ];
    }

    lastAnalysisResult = result;
    renderResult(result);
  } catch (err) {
    statusIndicator.innerHTML = '<span class="status-pill status-error">Error</span>';
    alert("Diagnostic error: " + err.message);
  } finally {
    loadingState.classList.add("hidden");
  }
}

function renderResult(res) {
  agentOutput.classList.remove("hidden");

  if (res.status === "OUT_OF_GAS") {
    statusBadge.textContent = "OUT OF GAS";
    statusBadge.className = "badge badge-warn";
    statusIndicator.innerHTML = '<span class="status-pill status-running">Out of Gas</span>';
  } else if (res.status === "SUCCESS") {
    statusBadge.textContent = "SUCCESS";
    statusBadge.className = "badge badge-success";
    statusIndicator.innerHTML = '<span class="status-pill status-success">Success</span>';
  } else if (res.status === "PENDING_OR_DROPPED") {
    // Previously fell through to the REVERTED branch, so "no receipt found" was
    // shown to the user as a reverted transaction.
    statusBadge.textContent = "NOT FOUND";
    statusBadge.className = "badge badge-warn";
    statusIndicator.innerHTML = '<span class="status-pill status-running">Pending or dropped</span>';
  } else {
    statusBadge.textContent = "REVERTED (STATUS 0)";
    statusBadge.className = "badge badge-error";
    statusIndicator.innerHTML = '<span class="status-pill status-error">Reverted</span>';
  }

  // Unknown custom errors carry their argument words; showing them is the whole
  // point of decoding structurally instead of reporting a bare selector.
  const args = res.errorArgs || [];
  if (args.length > 0) {
    argsRow.classList.remove("hidden");
    errorArgsText.textContent = args
      .map((a) => `[${a.index}] ${a.asUint !== undefined ? a.asUint : a.word}`)
      .join("  ·  ");
  } else {
    argsRow.classList.add("hidden");
  }

  errorType.textContent = res.revertType || res.status;
  errorSelector.textContent = res.selector || "N/A";
  errorCategory.textContent = res.category || (res.status === "OUT_OF_GAS" ? "ResourceLimit" : "EVM");
  revertReasonText.textContent = res.revertReason || res.diagnosis;

  // Remediation
  remediationList.innerHTML = "";
  const steps = res.steps || [res.remediation || "Check contract preconditions."];
  steps.forEach(step => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="remediation-bullet">✓</span> <span>${escapeHtml(step)}</span>`;
    remediationList.appendChild(li);
  });

  // Gas stats
  const used = Number(res.gasUsed || 0);
  const limit = Number(res.gasLimit || 0);
  statGas.textContent = limit > 0
    ? `${used.toLocaleString()} / ${limit.toLocaleString()}`
    : `${used.toLocaleString()} / unknown`;
  statGasPct.textContent = limit > 0 ? `${((used / limit) * 100).toFixed(1)}%` : "n/a";
  statBlock.textContent =
    res.blockNumber != null ? `#${Number(res.blockNumber).toLocaleString()}` : "unknown";

  // Audit trail
  traceList.innerHTML = "";
  const trail = res.auditTrail || [];
  trail.forEach(item => {
    const li = document.createElement("li");
    li.className = "trace-item";
    li.innerHTML = `
      <span class="trace-tag">${escapeHtml(item.step)}</span>
      <span class="trace-detail">${escapeHtml(item.detail)}</span>
    `;
    traceList.appendChild(li);
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

btnCopyJson.addEventListener("click", () => {
  if (!lastAnalysisResult) return;
  navigator.clipboard.writeText(JSON.stringify(lastAnalysisResult, null, 2));
  btnCopyJson.textContent = "Copied JSON";
  setTimeout(() => { btnCopyJson.textContent = "Copy Raw JSON"; }, 2000);
});

btnCopyMd.addEventListener("click", () => {
  if (!lastAnalysisResult) return;
  const res = lastAnalysisResult;
  const md = `### Pharos EVM Diagnostic Report
- **Status:** ${res.status}
- **Type:** ${res.revertType || res.status}
- **Selector:** \`${res.selector || "N/A"}\`
- **Root Cause:** ${res.revertReason || res.diagnosis}
- **Remediation Steps:**
${(res.steps || []).map(s => `  - ${s}`).join("\n")}
- **Gas Metrics:** ${res.gasUsed} / ${res.gasLimit}
- **Block:** ${res.blockNumber}`;

  navigator.clipboard.writeText(md);
  btnCopyMd.textContent = "Copied Markdown";
  setTimeout(() => { btnCopyMd.textContent = "Copy Markdown Report"; }, 2000);
});

// Run initial diagnosis on page load
executeDiagnosis();
