const TOKEN = process.env.GH_TOKEN;
const REPO = "chpi1124/fed-liquidity-monitor";
const RUN = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path) => {
  const r = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `token ${TOKEN}`, "User-Agent": "ci-watch" } });
  return r.json();
};
for (let i = 0; i < 40; i++) {
  const run = await api(`/repos/${REPO}/actions/runs/${RUN}`);
  console.log(new Date().toISOString().slice(11, 19), "run:", run.status, run.conclusion || "-");
  if (run.status === "completed") {
    const jobs = await api(`/repos/${REPO}/actions/runs/${RUN}/jobs`);
    for (const j of jobs.jobs || []) console.log("JOB", j.name, "|", j.conclusion);
    const fails = (jobs.jobs || []).filter((j) => j.conclusion === "failure");
    if (fails.length) {
      const log = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${fails[0].id}/logs`, { headers: { Authorization: `token ${TOKEN}` }, redirect: "follow" });
      const text = await log.text();
      const reds = text.split("\n").filter((l) => /RED|FAIL |Error:|Process completed/.test(l));
      console.log("=== FAILURE LINES ===");
      console.log(reds.slice(0, 40).join("\n"));
    }
    process.exit(run.conclusion === "success" ? 0 : 1);
  }
  await sleep(45000);
}
console.log("TIMEOUT after 40 polls");
process.exit(2);
