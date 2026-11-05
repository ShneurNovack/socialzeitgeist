// One run: collect what is due, read every post against its account, find the moments, score them
// against MM's history, write the brief.

import { composeBrief } from "./brief.js";
import { collectDue } from "./collect.js";
import { logRun } from "./db.js";
import { buildMoments, prune, readPosts, refreshTermDf, scoreMoments } from "./engine.js";
import { nameMoments, translateDue } from "./lang.js";

async function stage(env, name, fn) {
  const t = Date.now();
  try {
    const r = await fn();
    const msg = typeof r === "string" ? r : summarize(r);
    await logRun(env, name, "ok", msg, Date.now() - t);
    return { stage: name, status: "ok", message: msg, ms: Date.now() - t, result: r };
  } catch (err) {
    await logRun(env, name, "error", err.message, Date.now() - t);
    return { stage: name, status: "error", message: err.message, ms: Date.now() - t };
  }
}

function summarize(r) {
  if (!r || typeof r !== "object") return String(r ?? "");
  return Object.entries(r)
    .filter(([k, v]) => typeof v !== "object" || k === "errors")
    .map(([k, v]) => (k === "errors" && Array.isArray(v) ? (v.length ? `errors: ${v.slice(0, 3).join(" | ")}` : null) : `${k} ${v}`))
    .filter(Boolean)
    .join(", ");
}

export async function runPipeline(env, { budgetMs = 40000, collect = true } = {}) {
  const log = [];
  if (collect) log.push(await stage(env, "collect", () => collectDue(env, { budgetMs })));
  log.push(await stage(env, "translate", () => translateDue(env)));
  log.push(await stage(env, "terms", () => refreshTermDf(env)));
  log.push(await stage(env, "read", () => readPosts(env)));
  const built = await stage(env, "moments", () => buildMoments(env));
  log.push({ ...built, result: undefined });
  if (built.result) log.push(await stage(env, "score", () => scoreMoments(env, built.result)));
  log.push(await stage(env, "name", () => nameMoments(env)));
  log.push(await stage(env, "brief", async () => { const b = await composeBrief(env); return { moving: b.moving.length, gaps: b.gaps.length, outperformers: b.outperformers.length }; }));
  if (new Date().getUTCMinutes() < 10) log.push(await stage(env, "prune", () => prune(env).then(() => "ok")));
  return log;
}
