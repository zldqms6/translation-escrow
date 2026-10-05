# TranslationEscrow

Pay-on-acceptance escrow for translation jobs, judged by GenLayer validators instead of by the client who is paying.

## Why I built this

I write crypto campaign content in Korean and English. Translation work in this space keeps hitting the same standoff:
- The client gets the delivery and says "this isn't good enough."
- The translator says "you just don't want to pay."
- Both sides are partly right, and whoever holds the money wins.

Platforms that mediate this charge a large cut and take days.

The fix is to agree on the rules **before** the work starts and let a neutral party apply them. That neutral party is GenLayer. The judgment is subjective, the evidence is two public texts, and the result moves money.

## The agreement

The client opens a job and locks the reward. The job fixes:

| | |
|---|---|
| **Source text** | an https URL plus its **sha256**, so the text can't be swapped after the fact |
| **Languages** | e.g. `ko` → `en` |
| **Glossary** | pairs that must be translated a fixed way, e.g. `포인트` → `points` |
| **Brief** | tone and audience, up to 400 chars |
| **Minimum score** | 5–9 out of 10 |
| **Translator** | an assigned address |
| **Deadline** | at most 60 days out |

The translator delivers a URL plus its sha256. Committing the hash means the delivery can't be edited after it's judged.

## How a delivery is judged

```
deliver(job, url, sha256)
  ├─ code: source still matches its hash?   no → [EXTERNAL] error, nothing changes (not the translator's fault)
  ├─ code: delivery matches its hash?       ┐
  ├─ code: every glossary target present?   ├ any "no" → fail, the LLM is not called
  ├─ code: length ratio sane (0.35–6.0)?    ┘
  └─ LLM: accuracy 0–10, fluency 0–10, major errors
          score = round((2·accuracy + fluency) / 3), pass if score ≥ min_score
```

**Accuracy counts double.** A fluent translation that changes the meaning is worse than a clunky one that gets it right. A dropped or changed sentence, number or warning caps accuracy at 5.

**Every validator grades the delivery itself.** It accepts the leader's result only if:
- the code checks are identical,
- the pass/fail decision is the same,
- the score is within one point. Two graders rarely give the same number, but one point apart is the same opinion.

So a leader can't inflate a score or flip a fail into a pass. The tests cover both.

**Outcomes**
- **Pass:** the translator is paid immediately.
- **Fail:** one revision is allowed. A second fail refunds the client.
- **Deadline passes** with nothing accepted: the client reclaims the reward.

**Prompt injection.** The translation is written by the party who gets paid, so it is treated as hostile input:
- It sits in a `<translation>` block, and any stray `<translation>`/`<source>` tags inside it are stripped. It can't close its own block.
- The grader is told to ignore anything that addresses it or claims a score.
- The glossary and length gates are plain code and can't be talked around.

## Live run on Studionet (2026-10-05)

Contract: `0x2A35087a2f409B504D05D4758Da530A155EC21AC`

The texts are `examples/` in this repo at commit `55abbeb`, served from `raw.githubusercontent.com`, so their hashes are fixed. The source is an original Korean campaign notice for a fictional project, written for this demo.

**Job 0** (ko → en, glossary `포인트→points`, `유동성→liquidity`, min score 7, 5 GEN):

| Delivery | Code checks | Validators' grade | Result |
|---|---|---|---|
| `bad_en.txt`: fluent, glossary correct, but the daily cap changed to **50,000** and two warnings dropped | all pass | accuracy **2**, fluency 7 → score **4** | **revise** |
| `good_en.txt` (revision) | all pass | accuracy 10, fluency 10 → score 10 | **paid**, 5 GEN to the translator |

The grader listed the major errors in its own words:
- "Daily point cap changed from 5,000 to 50,000 points per wallet"
- "Warning about impermanent loss risk omitted entirely"
- "Warning about multi-wallet disqualification omitted entirely"

That is exactly what I broke on purpose. The glossary gate couldn't catch it, because the bad translation uses every required term correctly.

**Job 1.** The translator committed to the hash of `bad_en.txt` but pointed at `good_en.txt`. `delivery_hash_ok: false`, so the LLM was never called and the job went to **revise**.

Full output is in `demo_result.json`. Reproduce with `node scripts/live_demo.mjs <contract> <commit>`.

## API

| Method | Who | |
|---|---|---|
| `open_job(translator, source_url, source_sha256, src_lang, dst_lang, glossary_json, brief, min_score, deadline)` | client, payable | locks the reward |
| `deliver(job_id, url, sha256)` | assigned translator | judged in the same transaction; returns the verdict and new status |
| `reclaim(job_id)` | client | after the deadline, if nothing passed |
| `get_job(job_id)`, `get_job_count()` | anyone | the job includes the last verdict: checks, grade, major errors |

## Tests

```bash
py -3.12 -m venv .venv && .venv/Scripts/pip install genlayer-test
.venv/Scripts/python -m pytest tests -v
```

10 direct-mode tests use the files in `examples/`. They cover:
- input validation
- a good translation getting paid, with a validator one point lower still agreeing
- the flawed translation (5,000 → 50,000, two warnings dropped) failing even though the glossary is fine, then the revision passing
- two failures refunding the client
- glossary and length gates skipping the LLM
- a delivery that doesn't match its committed hash
- a changed source not being judged
- a prompt-injection attempt staying inside its data block
- validators rejecting an inflated score or a falsified check
- reclaim after the deadline

## Limits

- **Hosting.** The texts must stay at their URLs until judged. Pinned commit URLs (as in the demo) or content-addressed storage avoid surprises.
- **Grading noise.** LLM grading has noise. The one-point tolerance absorbs normal disagreement, and a split that can't reach a majority leaves the job unchanged so it can be resubmitted.
- **Text size.** Texts are cut at 6,000 characters each for the grader. Long documents should be split into several jobs.
- **Scope of judgment.** The grader judges translation fidelity, not whether the source itself is any good.
