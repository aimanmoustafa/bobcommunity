// Runs the labeled messages in tools/prefilter-cases.json through the real
// prefilter (compiled output in dist/) and reports every disagreement.
// Usage: npm run check:prefilter
const path = require("path");
const cases = require("./prefilter-cases.json");
const { prefilterMessage } = require(path.join(__dirname, "..", "dist", "ai", "prefilter.js"));

let failures = 0;
const show = (label, text, r) => console.log(`${label} [${r.reason}] ${text}`);

for (const text of cases.analyze) {
  const r = prefilterMessage(text);
  if (!r.shouldAnalyze) { failures++; show("MISSED FEEDBACK  ", text, r); }
}
for (const text of cases.skip) {
  const r = prefilterMessage(text);
  if (r.shouldAnalyze) { failures++; show("PASSED NOISE     ", text, r); }
}
for (const text of cases.knownMisses.analyze) {
  const r = prefilterMessage(text);
  console.log(`${r.shouldAnalyze ? "now handled      " : "known limitation  "} [${r.reason}] ${text}`);
}

for (const text of cases.knownLeaks.skip) {
  const r = prefilterMessage(text);
  console.log(`${r.shouldAnalyze ? "known leak        " : "now dropped       "} [${r.reason}] ${text}`);
}

const total = cases.analyze.length + cases.skip.length;
console.log(`\n${total - failures}/${total} correct`);
process.exit(failures ? 1 : 0);
