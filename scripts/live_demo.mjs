// Live run on Studionet. The texts are this repo's examples/ at a fixed commit, so
// their sha256 can't drift.   node scripts/live_demo.mjs <contractAddress> <commitSha>
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import crypto from "node:crypto";
import fs from "node:fs";

const [address, commit] = process.argv.slice(2);
const GEN = 10n ** 18n;
const raw = (f) => `https://raw.githubusercontent.com/zldqms6/translation-escrow/${commit}/examples/${f}`;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(`examples/${f}`)).digest("hex");

function key(name) {
  const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const m = env.match(new RegExp(`^${name}=(0x[0-9a-f]+)`, "m"));
  if (m) return m[1];
  const pk = generatePrivateKey();
  fs.appendFileSync(".env", `${name}=${pk}\n`);
  return pk;
}
async function fund(addr) {
  await fetch(studionet.rpcUrls.default.http[0], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sim_fundAccount", params: [addr, Number(1000n * GEN)] }),
  });
}

const client = createAccount(key("DEMO_CLIENT_PK"));
const translator = createAccount(key("DEMO_TRANSLATOR_PK"));
const gl = createClient({ chain: studionet });
await fund(client.address);
await fund(translator.address);

const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x)));
const read = async (functionName, args) =>
  plain(await gl.readContract({ address, functionName, args, transactionHashVariant: "latest-nonfinal" }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Studionet's shared LLM provider rate-limits bursts; a rate-limited call still shows ACCEPTED
// (validators agree it errored) but changes nothing, so check the leader result and retry.
async function write(account, functionName, args, value = 0n) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const hash = await gl.writeContract({ account, address, functionName, args, value });
    const r = await gl.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: 200, interval: 5000 });
    const leader = r?.consensus_data?.leader_receipt?.[0];
    const exec = leader?.execution_result;
    const err = leader?.genvm_result?.error_code;
    console.log(`${functionName} -> ${hash} ${r?.status_name ?? ""} ${exec ?? ""} ${err ?? ""}`);
    if (exec !== "ERROR" || err !== "LLM_RATE_LIMITED") return { hash, status: r?.status_name, exec, error: err };
    await sleep(90_000 * attempt);
  }
  throw new Error(`${functionName} kept hitting the LLM rate limit`);
}

const glossary = JSON.stringify([["포인트", "points"], ["유동성", "liquidity"]]);
const brief = "Plain English for a crypto audience. Keep every warning.";
const deadline = Math.floor(Date.now() / 1000) + 3 * 86400;
const out = { contract: address, network: "studionet", examples_commit: commit, jobs: [] };

async function job(label, deliveries) {
  const id = Number(await read("get_job_count", []));
  await write(client, "open_job", [translator.address, raw("source_ko.txt"), sha("source_ko.txt"), "ko", "en",
    glossary, brief, 7, deadline], 5n * GEN);
  const steps = [];
  for (const [file, shaOf] of deliveries) {
    await sleep(20_000);
    const tx = await write(translator, "deliver", [id, raw(file), sha(shaOf)]);
    const j = await read("get_job", [id]);
    console.log(`  ${label} / ${file}: status=${j.status}`, JSON.stringify(j.verdict));
    steps.push({ file, committed_sha_of: shaOf, tx: tx.hash, exec: tx.exec, status: j.status, verdict: j.verdict });
  }
  out.jobs.push({ label, id, steps });
}

await job("flawed first, then fixed", [["bad_en.txt", "bad_en.txt"], ["good_en.txt", "good_en.txt"]]);
await job("delivery does not match its committed hash", [["good_en.txt", "bad_en.txt"]]);
fs.writeFileSync("demo_result.json", JSON.stringify(out, null, 2));
