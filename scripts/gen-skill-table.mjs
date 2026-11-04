// Renders the selector tables in SKILL.md from the decoder itself.
//
// SKILL.md is instructions that another agent will read and trust. It shipped
// with the same thirteen wrong selectors the code had, because a human typed the
// table. Generating it from the module -- and failing the test suite when the two
// disagree -- is the only way a doc stays true.
//
// Usage:
//   node scripts/gen-skill-table.mjs          # print the block
//   node scripts/gen-skill-table.mjs --check  # exit 1 if SKILL.md is stale
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  KNOWN_CUSTOM_ERRORS,
  PANIC_CODES,
  selectorOf
} from "../src/diagnostics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const BEGIN = "<!-- BEGIN GENERATED SELECTORS -->";
export const END = "<!-- END GENERATED SELECTORS -->";

export function renderBlock() {
  const lines = [];

  lines.push("### Compiler `Panic(uint256)` codes");
  lines.push("");
  for (const [code, description] of Object.entries(PANIC_CODES)) {
    const hex = Number(code).toString(16).padStart(2, "0");
    lines.push(`- \`0x${hex}\`: ${description}`);
  }

  lines.push("");
  lines.push("### Custom errors");
  lines.push("");
  lines.push("Every selector below is the first four bytes of `keccak256(signature)`,");
  lines.push("computed at load time from the signature in the table. Re-derive with");
  lines.push("`node scripts/gen-skill-table.mjs`; do not type selectors by hand.");
  lines.push("");
  lines.push("| Selector | Signature | Category |");
  lines.push("| --- | --- | --- |");

  // KNOWN_CUSTOM_ERRORS is keyed by selector and built by hashing signatures at
  // load time, so re-derive the selector from the signature here and assert they
  // agree rather than trusting the key.
  const entries = Object.entries(KNOWN_CUSTOM_ERRORS)
    .map(([selector, meta]) => {
      const derived = selectorOf(meta.signature);
      if (derived !== selector) {
        throw new Error(
          `selector table is internally inconsistent: ${meta.signature} is stored as ${selector} but hashes to ${derived}`
        );
      }
      return { selector, ...meta };
    })
    .sort((a, b) => a.signature.localeCompare(b.signature));

  for (const e of entries) {
    lines.push(`| \`${e.selector}\` | \`${e.signature}\` | ${e.category || "—"} |`);
  }

  lines.push("");
  lines.push(`Total: ${entries.length} custom errors, ${Object.keys(PANIC_CODES).length} panic codes.`);
  return lines.join("\n");
}

export function fullBlock() {
  return `${BEGIN}\n${renderBlock()}\n${END}`;
}

function check() {
  const skillPath = join(HERE, "..", "SKILL.md");
  const text = readFileSync(skillPath, "utf8");
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    console.error("SKILL.md is missing the generated-selector markers.");
    return 1;
  }
  const actual = text.slice(begin, end + END.length);
  const expected = fullBlock();
  if (actual !== expected) {
    console.error("SKILL.md selector block is stale. Regenerate with:");
    console.error("  node scripts/gen-skill-table.mjs > /tmp/block && patch it in");
    return 1;
  }
  console.log("SKILL.md selectors match the decoder.");
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("gen-skill-table.mjs")) {
  if (process.argv.includes("--check")) {
    process.exit(check());
  }
  console.log(fullBlock());
}
