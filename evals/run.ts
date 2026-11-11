#!/usr/bin/env node
/**
 * Offline eval harness — `npm run eval`.
 *
 * This is the layer a model cannot be blamed for: what the guard classifies, and whether
 * the docs still describe the shipped config. Cases are data (`evals/cases/*.json`) so
 * adding one is a line, not a fixture; a known hole is `warn` and only fails with
 * `--strict`, so the gate stays green while the hole stays visible.
 *
 * Exit: 0 = clean, 1 = a failure (or a warning under --strict), 2 = bad invocation.
 */
import { guardSuite } from "./suites/guard.ts";
import { contractSuite } from "./suites/contract.ts";
import type { Result, Status, Suite } from "./types.ts";

const SUITES: Suite[] = [guardSuite, contractSuite];

type Counts = Record<Status, number>;

function countsOf(results: Result[]): Counts {
  const counts: Counts = { pass: 0, warn: 0, fail: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

async function main(argv: string[]): Promise<number> {
  const strict = argv.includes("--strict");
  const asJson = argv.includes("--json");
  const only = argv.indexOf("--suite");
  const onlyName = only >= 0 ? argv[only + 1] : undefined;
  if (only >= 0 && onlyName === undefined) {
    console.error("eval: --suite needs a name");
    return 2;
  }

  const suites = onlyName === undefined ? SUITES : SUITES.filter((suite) => suite.name === onlyName);
  if (suites.length === 0) {
    console.error(`eval: no suite named ${onlyName ?? ""}; known: ${SUITES.map((suite) => suite.name).join(", ")}`);
    return 2;
  }

  const report: Array<{ name: string; title: string; counts: Counts; results: Result[] }> = [];
  for (const suite of suites) {
    let results: Result[];
    try {
      results = await suite.run();
    } catch (error: unknown) {
      // A suite that cannot run is a failed suite, not a stack trace on stdout.
      results = [{ id: `${suite.name}/crashed`, status: "fail", detail: error instanceof Error ? error.message : String(error) }];
    }
    report.push({ name: suite.name, title: suite.title, counts: countsOf(results), results });
  }

  for (const entry of report) {
    entry.counts = countsOf(entry.results);
    entry.results.sort((a, b) => {
      const rank: Record<Status, number> = { fail: 0, warn: 1, pass: 2 };
      return rank[a.status] - rank[b.status] || a.id.localeCompare(b.id);
    });
  }

  const totals = report.reduce<Counts>(
    (sum, entry) => ({ pass: sum.pass + entry.counts.pass, warn: sum.warn + entry.counts.warn, fail: sum.fail + entry.counts.fail }),
    { pass: 0, warn: 0, fail: 0 },
  );
  const escapes = report
    .flatMap((entry) => entry.results)
    .filter((result) => result.status === "fail" && result.detail.startsWith("ESCAPE")).length;
  const gaps = report
    .flatMap((entry) => entry.results)
    .filter((result) => result.status === "warn" && result.detail.startsWith("KNOWN GAP")).length;

  if (asJson) {
    console.log(
      JSON.stringify({
        apiVersion: 1,
        type: "eval.run",
        data: {
          suites: report.map((entry) => ({ name: entry.name, title: entry.title, ...entry.counts })),
          totals: { ...totals, escapes, gaps },
          results: report.flatMap((entry) => entry.results.map((result) => ({ suite: entry.name, ...result }))),
        },
      }),
    );
  } else {
    for (const entry of report) {
      console.log(
        `${pad(entry.name, 10)} ${pad(String(entry.counts.pass), 4)} pass  ${pad(String(entry.counts.warn), 3)} warn  ${pad(String(entry.counts.fail), 3)} fail   ${entry.title}`,
      );
    }
    const notable = report.flatMap((entry) =>
      entry.results
        .filter((result) => result.status !== "pass")
        .map((result) => ({ suite: entry.name, ...result })),
    );
    if (notable.length > 0) {
      console.log("");
      for (const result of notable) {
        console.log(`${result.status === "fail" ? "FAIL" : "warn"}  ${result.suite}/${result.id}: ${result.detail}`);
      }
    }
    console.log("");
    console.log(
      `${totals.pass} pass, ${totals.warn} warn (${gaps} known guard gap${gaps === 1 ? "" : "s"}), ${totals.fail} fail, ${escapes} escape${escapes === 1 ? "" : "s"} (dangerous calls that ran unattended)`,
    );
    if (strict && totals.warn > 0) console.log(`--strict: ${totals.warn} warning${totals.warn === 1 ? "" : "s"} counted as failures`);
  }

  if (totals.fail > 0) return 1;
  if (strict && totals.warn > 0) return 1;
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
