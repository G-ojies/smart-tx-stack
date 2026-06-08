import { TipFloor } from "../types";

const TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";

/**
 * Dynamic tip calculation from *live* Jito tip-floor data — no hardcoded tips.
 *
 * The tip floor endpoint returns recent landed-tip percentiles (in SOL); we
 * convert to lamports and pick a percentile based on how aggressive we want to
 * be, clamped to a safety ceiling.
 */
export async function fetchTipFloor(): Promise<TipFloor> {
  const res = await fetch(TIP_FLOOR_URL);
  if (!res.ok) throw new Error(`tip_floor HTTP ${res.status}`);
  const arr = (await res.json()) as any[];
  const d = Array.isArray(arr) ? arr[0] : arr;
  const sol = (x: any) => Math.round(Number(x || 0) * 1e9); // SOL → lamports
  return {
    p25: sol(d.landed_tips_25th_percentile),
    p50: sol(d.landed_tips_50th_percentile),
    p75: sol(d.landed_tips_75th_percentile),
    p95: sol(d.landed_tips_95th_percentile),
    p99: sol(d.landed_tips_99th_percentile),
    ema: sol(d.ema_landed_tips_50th_percentile),
    fetchedAt: Date.now(),
  };
}

export type Aggressiveness = "low" | "medium" | "high";

/**
 * Compute a tip from live floor data.
 * @param floor   live tip-floor percentiles (lamports)
 * @param level   how hard to compete for landing
 * @param maxTip  hard safety ceiling (lamports)
 * @param minTip  Jito minimum (1000 lamports)
 */
export function computeTip(
  floor: TipFloor,
  level: Aggressiveness,
  maxTip: number,
  minTip = 1000
): number {
  const base =
    level === "high" ? floor.p95 : level === "medium" ? floor.p75 : floor.p50;
  // Blend with EMA to smooth single-sample spikes.
  const blended = Math.round(0.7 * base + 0.3 * floor.ema);
  return Math.max(minTip, Math.min(blended || minTip, maxTip));
}
