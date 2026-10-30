// Run: node worker/vote.test.mjs
import { voteReadings } from "./src/vote.js";

const r = (percent, extra = {}) => ({ percent, charging: null, note: "", ...extra });
const cases = [
  ["three agree", [r(72), r(72), r(72)], { percent: 72, agreed: true, count: 3 }],
  ["two of three agree", [r(72), r(70), r(72)], { percent: 72, agreed: true, count: 2 }],
  ["all three differ: no answer", [r(72), r(70), r(68)], { percent: null, agreed: false, count: 1 }],
  ["one unreadable, two agree", [r(72), r(null), r(72)], { percent: 72, agreed: true, count: 2 }],
  ["only one readable of three: no answer", [r(72), r(null), r(null)], { percent: null, agreed: false, count: 1 }],
  ["nothing readable", [r(null), r(null), r(null)], { percent: null, agreed: false, count: 0 }],
  ["single photo", [r(55)], { percent: 55, agreed: true, count: 1 }],
  ["single unreadable photo", [r(null)], { percent: null, agreed: false, count: 0 }],
  ["2 vs 2 tie is not a majority", [r(72), r(72), r(70), r(70)], { percent: null, agreed: false, count: 2 }],
  ["3 of 5", [r(40), r(41), r(40), r(40), r(null)], { percent: 40, agreed: true, count: 3 }],
  ["decimals/strings are ignored", [r(72.5), r("72"), r(72)], { percent: null, agreed: false, count: 1 }],
];
let bad = 0;
for (const [name, input, want] of cases) {
  const got = voteReadings(input);
  const ok = Object.entries(want).every(([k, v]) => got[k] === v);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `   got ${JSON.stringify({ percent: got.percent, agreed: got.agreed, count: got.count })}`}`);
  if (!ok) bad++;
}
const c = voteReadings([r(60, { charging: true, note: "clear" }), r(60, { charging: true }), r(61, { charging: false })]);
console.log(`${c.charging === true && c.note === "clear" && c.winnerIndex === 0 ? "PASS" : "FAIL"}  charging flag and note come from the winning photos`);
if (!(c.charging === true && c.note === "clear" && c.winnerIndex === 0)) bad++;
console.log(bad ? `\n${bad} failed` : "\nall passed");
process.exit(bad ? 1 : 0);
