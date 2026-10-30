// Majority vote across several readings of the same display: one blurry or glared photo can't change the answer.
// A percentage is accepted only when MORE THAN HALF of the photos give the same number; otherwise there is no answer.
export function voteReadings(readings) {
  const total = readings.length;
  const vals = readings.map((r) => r.percent).filter((v) => Number.isInteger(v));
  const tally = new Map();
  for (const v of vals) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best = null;
  for (const [value, count] of tally) if (!best || count > best.count) best = { value, count };
  const agreed = Boolean(best) && best.count > total / 2;
  const winners = readings.filter((r) => agreed && r.percent === best.value);
  const flags = winners.map((r) => r.charging).filter((c) => typeof c === "boolean");
  return {
    percent: agreed ? best.value : null, agreed, count: best?.count ?? 0, total, values: vals,
    charging: flags.length ? flags.filter(Boolean).length > flags.length / 2 : null,
    note: winners.find((r) => r.note)?.note ?? readings.find((r) => r.note)?.note ?? "",
    winnerIndex: agreed ? readings.findIndex((r) => r.percent === best.value) : -1,
  };
}
