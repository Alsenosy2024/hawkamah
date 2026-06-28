# PRD — Assessment Flow Fixes & App-Wide Anti-Cheat

**Project:** Hawkamah (`ai-interviewer`) — Arabic-first RTL governance & employee-assessment webapp
**Author / source:** Karem — extracted from voice note `WhatsApp_Ptt_2026-06-26` + 4 reference screenshots
**Date:** 2026-06-28
**Status:** Draft for build — work the items **one by one**, top to bottom
**Deadline context:** Owner wants this stabilized to demo to *Dr. Omar* and publish shortly after.

---

## 🤝 How sessions coordinate (READ THIS FIRST — before touching anything)

Several Claude Code sessions edit this file at the same time. There is **no lock and no server** — the only thing that serialises us is **`git push` to the shared coordination ref** (`main` → `origin/main`). This whole section is the protocol; it lives in the file because the file is all a fresh session can see.

### Golden rules
1. **The CLAIMS BOARD below is the single source of truth for who-owns-what.** Always `git pull --rebase` and re-read it before you act. Never trust a stale copy.
2. **One item = one branch = one owner.** Do **not** start coding an item until your claim commit is on `origin/main` and has survived the re-read (claim steps 5–7). Starting early is the #1 cause of two sessions building the same thing.
3. **Board / claim / log edits go in their own tiny commits on `main` — NEVER inside a feature-branch PR.** If a feature PR touched the board, merging it would silently revert other sessions' rows.
4. **First push wins.** If your push is rejected or your row rebases to someone else's SID, you lost the race — yield and pick another item.
5. **The activity log is append-only. On a conflict, KEEP BOTH LINES (union).** Never resolve the log with `git checkout --ours/--theirs` — that deletes another session's history.

### Your session id (`SID`)
Generate it **once**, then reuse the **literal string** everywhere (row Owner cell, log lines, commit trailers). Shell env vars do **not** survive between tool calls, so copy the printed value and type it literally.
```bash
# run ONCE at session start; copy the output and reuse it verbatim all session:
printf 's-%s-%s\n' "$(date -u +%m%d-%H%M)" "$(openssl rand -hex 2)"   # e.g. s-0628-1430-9f3a
```

### Status legend
| Mark | Meaning | Claimable? |
|------|---------|-----------|
| ⬜ TODO | free | yes |
| 🟦 CLAIMED | reserved, work not started | no — until stale (60 min) |
| 🟨 WIP | in progress, branch pushed | no — until stale (3 h, no commits) |
| 🟪 PR-OPEN | open PR awaiting merge | no |
| 🚢 SHIPPED | merged to `main` / in prod | no |
| ⏳ VERIFY | shipped, needs live runtime check | claim the **verification** only |
| ✅ DONE | verified / complete | no |
| ⛔ BLOCKED | waiting on a dependency | no — until the dep is 🚢 |
| ⚪ PARKED | released, reclaimable | yes |

### Canonical branch names (fixed — everyone computes the identical ref)
`A1 item/A1-jobtitle-suggest` · `A2 item/A2-onboarding-rules` · `A3 item/A3-voice-recording` · `A4 item/A4-puck-voice` · `A5 item/A5-skip-question` · `A6 item/A6-exit-flow` · `B1 item/B1-useproctor-hook` · `B2 item/B2-multimonitor` · `B3 item/B3-anticheat-surfaces`

### Claiming an item (commit-first; the push is the lock)
```bash
# 0. SYNC
git checkout main && git pull --rebase origin main
# 1. PICK a row whose Status is ⬜ TODO or ⚪ PARKED and Owner is "—". Skip ⛔ BLOCKED.
# 2. CONFIRM it isn't already finished (merged branches are DELETED, so empty branch list ≠ free):
gh pr list --state all --search "A5" --json number,state,headRefName
# 3. WRITE the claim — edit ONLY your row's 4 cells (Status→🟦 CLAIMED, Owner→<SID>,
#    Branch·PR→item/A5-skip-question, Updated→date -u +'%Y-%m-%d %H:%M') + append ONE log line.
# 4. COMMIT just that, as its own tiny commit:
git add PRD-assessment-anticheat.md && git commit -m "claim(A5): <SID>" --trailer "Claim-Session=<SID>"
# 5. REBASE onto whatever landed: git pull --rebase origin main
#    • conflict on YOUR row → you LOST: git rebase --abort, log a lost-race line, pick another item.
#    • conflict on the LOG  → keep BOTH lines, git add -A, git rebase --continue.
# 6. PUSH — this is the atomic lock:  git push origin main   (rejected → pull --rebase, retry step 5)
# 7. RE-READ (lost-race detector): git pull --rebase origin main; confirm your row STILL shows your SID.
# 8. ONLY NOW branch and work:  git switch -c item/A5-skip-question   (flip row to 🟨 WIP on first push)
```

### While you work
- Every coordination commit, **bump your row's Updated cell** — that timestamp **is** your heartbeat.
- Tick acceptance-criteria boxes (in this item's section) + subtask boxes **in your own item block** — you are the only writer there. Bundle the tick + Updated bump + one log line into a single small commit to `main`.
- When you open the PR → flip Status to 🟪 PR-OPEN and put the PR URL in the Branch·PR cell.

### Releasing / finishing
- **Abandon:** Status → ⚪ PARKED, Owner → "—", append a `park` log line. Now reclaimable.
- **PR merged:** confirm `gh pr view <key> --json state` → set 🚢 SHIPPED. If it unblocks another item, flip that row ⛔ BLOCKED → ⬜ TODO and log an `unblock` line. (B3 unblocks on **B1 SHIPPED**.)
- **A3 only:** it is 🚢 SHIPPED · ⏳ VERIFY. The remaining task is the **live VU-meter verification** in a real proctored exam. Whoever runs it flips A3 → ✅ DONE and logs the result. **Nobody re-implements A3.**

### Stale-claim reclamation (explicit timeouts)
Reclaimable when Status is 🟦 CLAIMED/🟨 WIP, Updated is past the TTL, **and** there's no live evidence of work:
- 🟦 CLAIMED, no branch pushed → stale after **60 minutes**.
- 🟨 WIP with a branch → stale after **3 hours with no new commit** on its branch **and** no open PR.

Prove it's dead against artifacts, not just the clock (`gh pr list --search "<ID>"`; `git log -1 --format=%cI origin/item/<branch>`). Reclaim in **two separate commits**: (1) PARK it, push; (2) run the normal claim ritual.

### Conflict handling (deterministic)
- **Your-row rebase conflict / push rejected then your row shows another SID** → you lost. Abort, log `lost-race`, pick another item.
- **Two SIDs on one row** → the **earlier claim commit on the shared ref wins** (`git log --format='%cI %s' -- PRD-assessment-anticheat.md`; ties → lexicographically smaller SID). Loser reverts the row and re-claims elsewhere.
- **Activity-log conflict** → always **union (keep every line)**; never `--ours/--theirs`.
- **Item-block conflict** → shouldn't happen (single-writer). If it does, the current board Owner wins.
- **Board vs git disagree about "done"** → **git wins** (a merged PR = 🚢 SHIPPED), **except** the ⏳ VERIFY residual, which only a human/verifier clears.

> ⚠️ Concurrency safety depends on a real git remote as the serialization point. If sessions instead **share this one working directory** (no separate clones), the same board/claim/log discipline still applies but the "lock" is the shared file — **re-read the board immediately before claiming** and keep claims to one-row edits.

## 📋 CLAIMS BOARD — single source of truth (claim ritual above)

Rows are in **fixed order (A1…B3) — never reorder them** (reordering = huge diffs = collisions). Only the **Status / Owner / Branch·PR / Updated** cells ever change.

| Item | Title | P | Eff | Status | Owner (SID) | Branch · PR | Updated (UTC) |
|------|-------|----|-----|--------|-------------|-------------|----------------|
| A1 | Auto-suggest job titles from company industry | P1 | M | ⬜ TODO | — | — | — |
| A2 | Pre-test onboarding: rules, prohibitions & attempts | P1 | M | 🟦 CLAIMED | s-0628-1453-525d | item/A2-onboarding-rules | 2026-06-28 15:20 |
| A3 | Voice-answer recording produces empty audio | P0 | M | 🚢 SHIPPED · ⏳ VERIFY | — | `709e02a` (prod) | 2026-06-28 06:06 |
| A4 | Narration uses robotic fallback voice, not Puck | P1 | M | 🟦 CLAIMED | s-0628-1514-f086 | item/A4-puck-voice | 2026-06-28 15:15 |
| A5 | Skip question (one-way, no return) | P1 | S | 🚢 SHIPPED | s-0628-1453-525d | [PR #30](https://github.com/Alsenosy2024/hawkamah/pull/30) · `3c7e580` (prod) | 2026-06-28 15:09 |
| A6 | Completion / exit flow polish | P2 | S | ⬜ TODO | — | — | — |
| B1 | Extract shared `useProctor` hook + provider | P1 | L | ⬜ TODO | — | — | — |
| B2 | Multi-monitor / extended-display detection | P1 | M | ⬜ TODO | — | — | — |
| B3 | Apply anti-cheat to all candidate-facing surfaces | P1 | L | ⛔ BLOCKED · needs B1 🚢 | — | — | — |

**Polite build order (not enforced):** A3 → A4 → A5 → A2 → A1 → B1 → B2 → B3 → A6.
**Dependencies:** B3 needs **B1 SHIPPED** (B1's owner flips B3 → ⬜ TODO on merge). A3 is terminal except its ⏳ live verification — claim only the verification, never re-implement it.

## How to read this doc

Each item is a **self-contained work unit**: it states what exists in the code *today*, the problem, the goal, exact acceptance criteria, the files/lines it touches, and an implementation hypothesis. Tackle them in priority order. Check the box when an item ships as an **open PR** (this project never auto-merges/deploys — see repo conventions).

| Priority | Meaning |
|----------|---------|
| **P0** | Blocks the demo — a real bug that breaks the flow |
| **P1** | Core ask from the recording — must land before publish |
| **P2** | Polish — improves UX but not blocking |

| Effort | Rough size |
|--------|-----------|
| **S** | < ½ day, localized change |
| **M** | 1–2 days, touches a few files |
| **L** | Multi-file refactor or new subsystem |

---

## Summary table

| # | Item | Type | Priority | Effort | In code today? |
|---|------|------|----------|--------|----------------|
| A1 | Auto-suggest job titles from company industry | Feature | P1 | M | Partial — prefill from `jobRoles` works; industry→titles derivation **missing** |
| A2 | Pre-test onboarding: rules, prohibitions & attempts | Feature | P1 | M | Partial — briefing exists, **no rules/prohibitions step** |
| A3 | **Voice-answer recording is broken (empty capture)** | Bug | **P0** | M | Implemented via deprecated `ScriptProcessorNode`; user reports empty recordings |
| A4 | Narration uses robotic fallback voice, not Puck | Bug | P1 | M | `Puck` is configured; bad voice = Web-Speech fallback |
| A5 | Skip question (one-way, no return) | Feature | P1 | S | **Missing** — forward-only, no skip control |
| A6 | Completion / exit flow polish | Polish | P2 | S | Partial — `attempt_done`/`all_done` exist; needs exit control + clearer retry messaging |
| B1 | Extract shared `useProctor` hook + provider | Refactor | P1 | L | Duplicated inline across 3 portals |
| B2 | Multi-monitor / extended-display detection | Feature | P1 | M | **Missing** — no `multiple_displays` signal |
| B3 | Apply anti-cheat to all candidate-facing surfaces | Feature | P1 | L | Only on 3 assessment portals; surveys unguarded |

---

# EPIC A — Assessment flow (from the voice note, in walkthrough order)

## A1 — Auto-suggest job titles from the company's industry
**Track:** ⬜ TODO · **Owner:** — · **Branch·PR:** `item/A1-jobtitle-suggest` · **Updated:** — · **ACs:** 0/5  ·  *(tick this item's `### Acceptance criteria` boxes in place as they land; owner adds subtasks here on claim)*

**Type:** Feature · **Priority:** P1 · **Effort:** M
**Recording:** *"In the job titles, it should automatically create them based on the nature of the company… a real-estate company has project manager, site engineer, accountant… bring them ready, I remove or add, instead of being empty."* (~0:33–1:00)
**Screenshot:** Image #2 — the المسميات الوظيفية textarea (highlighted).

### What exists today
- The setup modal lives in `components/ProjectsStage.tsx:642–656`. The job-titles field is a `<textarea>` (one title per line), value `unifiedCfg.allowedJobTitles`.
- It **is** pre-populated — but only from `p.jobRoles` (`ProjectsStage.tsx:105–119`), mapping each role's `title_ar`/`title_en`.
- The data model already carries the company sector: `GovProject.industry` and `GovProject.specialization` (`types.ts:139–140`), and a code comment (`types.ts:143`) explicitly says job titles should be *"derived from `industry` when empty."*
- **Gap:** that derivation is **not implemented**. If a project has no `jobRoles`, the field is empty (placeholder only).

### Goal
When the setup modal opens, the job-titles field is **pre-filled with sensible, industry-appropriate titles** drawn from the company's `industry`/`specialization`, even when `jobRoles` is empty. The user can freely add/remove lines. Never start empty for a company whose industry is known.

### Behavior
1. On modal open, compute the suggested titles:
   - If `p.jobRoles` is non-empty → use them (current behavior, unchanged).
   - Else if `p.industry` is set → generate 5–8 role titles appropriate to that sector (e.g. عقاري/Real-estate → مدير مشاريع، مهندس موقع، محاسب، مدير تطوير، أخصائي مبيعات، منسق مشاريع).
2. Suggestions are **editable** — they populate the textarea as normal lines; removing/adding works as today.
3. Provide a small **"اقترِح مسميات" (Suggest titles)** affordance to re-generate/refresh if the user cleared them.

### Generation source — pick one (decide in build)
- **(a) Static sector→titles map** (deterministic, instant, offline). A lookup keyed by `industry` with a curated default list. Fast, predictable, no token cost. **Recommended default.**
- **(b) Gemini generation** from `industry` + `specialization` + company name (via existing `geminiService`). Richer/more specific, but adds latency + cost + a failure path. Could be the "refresh/suggest" button while (a) seeds the initial fill.
- Best: **(a) for the instant prefill, (b) behind the explicit "Suggest" button.**

### Acceptance criteria
- [ ] Opening the modal for a real-estate company with **no `jobRoles`** shows a non-empty, relevant title list.
- [ ] The list is editable; the created link's `allowedJobTitles` reflects the final edited list.
- [ ] Companies *with* `jobRoles` are unchanged (no regression).
- [ ] A company with an unknown/blank `industry` falls back to today's empty+placeholder behavior (no crash).
- [ ] `tsc --noEmit` clean; existing tests pass.

### Files
- `components/ProjectsStage.tsx` (`105–119` prefill, `642–656` textarea)
- `types.ts` (`134–147` `GovProject`)
- New: a `services/jobTitleSuggestions.ts` (the sector→titles map / generation helper)

---

## A2 — Pre-test onboarding: exam rules, prohibitions & attempts
**Track:** 🟦 CLAIMED · **Owner:** s-0628-1453-525d · **Branch·PR:** `item/A2-onboarding-rules` · **Updated:** 2026-06-28 15:20 · **ACs:** 0/5
**Subtasks (owner):**
- [ ] New `onboarding` stage between `briefing` and `generating` (forward gate; access-code validated on entry)
- [ ] How-it-works panel + dynamic attempts from `tok.maxAttempts`
- [ ] Prohibitions: always-on DOM group (tab/blur/fullscreen/copy) + camera-gated vision group — mirror `proctorCore` signals
- [ ] Monitoring notice + explicit acknowledgement checkbox gating «أوافق وأبدأ»

**Type:** Feature · **Priority:** P1 · **Effort:** M
**Recording:** *"It should tell him: these are the instructions — the exam works like this, you have only two attempts. Then: do this, you'll take that, note — forbidden X, forbidden Y, forbidden Z — so onboarding starts."* (~1:10–1:32)
**Screenshot:** Image #3 — the welcome screen (أهلاً بك في التقييم).

### What exists today
- Flow in `components/UnifiedAssessmentPortal.tsx`: `identify → job_pick → briefing → generating → exam → attempt_done → all_done`.
- `identify` stage shows an AI-monitoring notice (`UnifiedAssessmentPortal.tsx:668–671`).
- `briefing` stage (`748–857`) shows exam composition + device checks (mic/camera) + access code.
- **Gap:** there is **no explicit rules / prohibitions step** — no clear list of what's forbidden, no prominent "you have N attempts" framing, no "by starting you agree" gate. The user wants a real onboarding beat before the test.

### Goal
A dedicated **onboarding/instructions step** (between `briefing` and the first question, or folded into `briefing`) that clearly communicates: how the exam works, the attempts limit, and an explicit **prohibitions list**, with an acknowledgement before entry.

### Content to show (Arabic-first)
- **كيف يعمل الاختبار:** عدد الأسئلة، الوقت لكل سؤال، نوعها (سلوكي/فني/صوتي)، أنها للأمام فقط.
- **المحاولات:** "لديك {maxAttempts} محاولتان فقط" — pulled from `tok.maxAttempts`.
- **الممنوعات (prohibitions):** فتح تبويب/نافذة أخرى، الخروج من ملء الشاشة، النسخ/اللصق، استخدام أدوات ذكاء اصطناعي، وجود شخص آخر، استخدام شاشة ثانية. (Mirror the real proctor signals so the rules match what actually gets flagged — see `proctorCore.ts` signal list.)
- **المراقبة:** الكاميرا ومشاركة الشاشة مفعّلة بالذكاء الاصطناعي.
- A **"أوافق وأبدأ" (I agree & start)** button that gates entry.

### Acceptance criteria
- [ ] Before the first question, the candidate sees a distinct instructions/prohibitions screen.
- [ ] Attempts count is shown dynamically from the token (`maxAttempts`).
- [ ] The prohibitions listed match the signals the proctor actually detects (no rule we don't enforce, no enforced rule we don't disclose).
- [ ] Entry is gated by an explicit acknowledgement.
- [ ] Bilingual (AR/EN) via the existing i18n `t()` pattern; RTL correct.

### Files
- `components/UnifiedAssessmentPortal.tsx` (`644–857` stages; add/extend a step)
- (Consider sharing the prohibitions copy with `OnlineAssessmentPortal.tsx` for consistency.)

---

## A3 — 🐛 Voice-answer recording produces empty audio (P0)
**Track:** 🚢 SHIPPED · ⏳ VERIFY · **Owner:** — · **Branch·PR:** `709e02a` (prod) · **Updated:** 2026-06-28 06:06 · **ACs:** 1/5  ·  *(code shipped & deployed; only the live VU-meter verification in a real proctored exam remains — claim the **verification**, do NOT re-implement)*

**Type:** Bug · **Priority:** P0 · **Effort:** M
**Recording:** *"I came to record — it doesn't record. You click the button — it doesn't record. The voice questions… the audio just empties — it doesn't record."* (~2:09–2:18)

### What exists today
- Recorder: `lib/audioRecorder.ts` — `MicRecorder` class.
- It captures raw PCM via **`ScriptProcessorNode`** (`audioRecorder.ts:115`), buffers `Float32Array` chunks in `onaudioprocess` (`118–126`), and on `stop()` throws **`MicRecordError('empty', 'No audio captured.')`** when `total === 0` samples (`audioRecorder.ts:160–161`).
- UI wiring: `UnifiedAssessmentPortal.tsx:369–387` (`startRecording`) and `389–410` (`stopRecording` → `transcribeAudio`).

### Root-cause hypothesis (strong)
The user's symptom — *"الصوت يفرّغ"* (it comes back empty) — maps **exactly** to the `total === 0` → `'empty'` path. That means `onaudioprocess` **never fired** (no chunks captured). Most likely causes, in order:
1. **`ScriptProcessorNode` is deprecated and unreliable** — in current Chrome it can fail to fire `onaudioprocess`, especially while other media is active. During the unified exam, the **proctor holds a camera stream + screen-share + a Gemini Live audio session** simultaneously; this is exactly the contention case where ScriptProcessor goes silent.
2. **Forced 16 kHz `AudioContext`** (`audioRecorder.ts:111`) — some hardware/browsers won't honor a 16 kHz context and leave it suspended, so `onaudioprocess` never runs even after `resume()`.
3. **Mic contention** — a second `getUserMedia({audio})` while the proctor/TTS pipeline holds audio I/O.

### Goal
Voice answers record reliably **during a live proctored exam**, with the captured audio transcribed. No silent empty failures.

### Fix direction (recommended)
- **Replace `ScriptProcessorNode` with `MediaRecorder`** (record to `audio/webm;codecs=opus` or `audio/mp4`), then hand the blob to `transcribeAudio`. `MediaRecorder` is the modern, battle-tested path and doesn't suffer the ScriptProcessor silence. (Fallback: `AudioWorklet` if raw PCM/WAV is required for the transcription endpoint — verify what `transcribeAudio` accepts.)
- Add a **live input-level meter** on the record button so the candidate *sees* the mic is capturing (also surfaces the failure immediately).
- Keep the typed `MicRecordError` reasons; ensure `'empty'` is only thrown after a genuine silent capture, and show an actionable retry.
- Confirm `transcribeAudio` (`services/…`) accepts the chosen mime type.

### Acceptance criteria
- [ ] **Reproduce first**: take a voice question in a fully-proctored unified exam (camera + screen-share on) and confirm the empty-capture failure, then confirm the fix records non-empty audio in that same scenario.
- [x] Record button shows live level feedback while recording. *(VU meter shipped in 709e02a)*
- [ ] Stopping yields a transcript (or a clear, actionable error — never a silent empty).
- [ ] Works with the proctor session active (the real-world condition).
- [ ] No regression to the conversational-interview streaming use of `MicRecorder` (`flush()`/`discard()` in `VerbalAssessmentScreen`).

### Files
- `lib/audioRecorder.ts` (core fix)
- `components/UnifiedAssessmentPortal.tsx` (`369–410`)
- `components/VerbalAssessmentScreen.tsx` (streaming consumer — regression-check)
- `services/*` transcription entry (`transcribeAudio`)

> ⚠️ This is the one item that genuinely needs **runtime verification** (mic + camera + screen-share). Use the `/verify` flow with a real proctored exam to confirm repro and fix.

---

## A4 — Narration uses the robotic fallback voice instead of Puck
**Track:** 🟦 CLAIMED · **Owner:** s-0628-1514-f086 · **Branch·PR:** `item/A4-puck-voice` · **Updated:** 2026-06-28 15:15 · **ACs:** 0/3
**Subtasks (owner):**
- [ ] Diagnose why the Puck path (dedicated TTS `3.1-flash-tts` → LIVE native-audio) falls through to Web-Speech (timeouts too tight? auth/cold-start?)
- [ ] Make the Puck path reliable + extend `ttsPrefetch` caching of upcoming question audio
- [ ] Demote/gate the Web-Speech fallback behind a visible "voice unavailable" notice (no silent jarring swap)
- [ ] Audit `speakProctorAlarm()` voice + 12 s throttle so the alarm never clashes with question narration

**Type:** Bug · **Priority:** P1 · **Effort:** M
**Recording:** *"When it runs, there's 'Obeid' the dumb voice — stupid, interrupting… For onboarding there's 'Puck' — Puck in Gemini sounds nice and good, this is very important — the voice that comes out."* (~1:33–1:52)

### What exists today
- `services/ttsService.ts:25–29` already sets the **male voice to `Puck`** (owner-mandated 2026-06-16: "بوكا — best Arabic voice"). Female = `Kore`.
- Voice chain (`ttsService.ts:310–323`): **(1)** dedicated TTS `3.1-flash-tts` (38 s timeout) → **(2)** LIVE native-audio (24 s timeout) → **(3) Web Speech API** browser fallback.
- Exam narration: `UnifiedAssessmentPortal.tsx:50` `speakQuestion()` → `ttsSpeak(text, { gender:'male', lang:'ar-SA' })`.

### Root-cause hypothesis
Puck is configured, so the bad "Obeid" voice the user hears is almost certainly the **Web Speech API fallback (step 3)** — the OS/browser default Arabic voice, which is flat and robotic. It triggers whenever steps 1–2 time out or fail. Separately, the **proctor alarm** (`proctorService.ts` `speakProctorAlarm()`) uses "a male Gemini TTS voice" — verify it's also Puck and isn't the interrupting "stupid voice" the user described.

### Goal
The candidate consistently hears the **Puck** voice for question narration and onboarding; the robotic Web-Speech fallback effectively never plays in normal conditions; the proctor alarm doesn't talk over / clash with question narration.

### Fix direction
- Make the **Puck path reliable**: investigate why steps 1–2 fall through (timeouts too tight? token/auth failures? cold-start latency?). Consider **prefetch/caching** of upcoming question audio (a `ttsPrefetch` already exists at `UnifiedAssessmentPortal.tsx:437–441` — extend its use).
- **Demote or gate the Web-Speech fallback** so it's a last resort with a visible "voice unavailable" hint rather than silently swapping in a jarring voice — or drop it entirely if product prefers no audio over bad audio.
- Audit `speakProctorAlarm()` voice + its 12 s throttle so the alarm never "interrupts" mid-question narration (coordinate with `cancelSpeech()`).

### Acceptance criteria
- [ ] In a normal session, question + onboarding narration plays in the Puck voice (verified by ear).
- [ ] Web-Speech fallback only engages on genuine TTS outage, and is clearly distinguishable/labelled (or removed).
- [ ] Proctor alarm uses an acceptable voice and does not clash with question narration.

### Files
- `services/ttsService.ts` (`25–29`, `310–323`)
- `services/proctorService.ts` (`speakProctorAlarm`)
- `components/UnifiedAssessmentPortal.tsx` (`50`, `437–441`)

---

## A5 — Skip question (one-way, no return)
**Track:** 🚢 SHIPPED · **Owner:** s-0628-1453-525d · **Branch·PR:** [PR #30](https://github.com/Alsenosy2024/hawkamah/pull/30) · merge `3c7e580` · **Updated:** 2026-06-28 15:09 · **ACs:** 4/4 · *(merged + deployed to prod; optional residual: click-through the skip control in a live exam)*
**Subtasks (owner):**
- [x] Add `goSkipQ()` path (record current Q as unanswered, advance via `goNextQ`, never revisit)
- [x] Skip button on MCQ render + voice render (shared control at card footer)
- [x] Converge timer-expiry / skip / answer on one advance path (no double-advance)
- [x] Confirm scoring treats skipped as unanswered/incorrect (unit test — 13/13 pass)

**Type:** Feature · **Priority:** P1 · **Effort:** S
**Recording:** *"The question I can't answer — it's right in front of me — 'skip the question', done. It doesn't come back — of course, once skipped."* (~1:55–2:08)

### What exists today
- Navigation is **forward-only**, no skip (`UnifiedAssessmentPortal.tsx:427–442` `goNextQ`).
- MCQ auto-advances on answer (`~1055`); voice questions require record+save then "السؤال التالي" (`1066–1068`); timer expiry auto-advances (`356–364`). There is **no way to skip an MCQ you can't answer** without picking an option, and no explicit skip affordance.

### Goal
A visible **"تجاوز السؤال" (Skip)** control that advances past the current question. Skipped questions are recorded as unanswered, are **not revisitable**, and don't break scoring.

### Behavior
- Skip button present on each question (MCQ + voice).
- On skip: record the question as unanswered (empty answer), advance via the existing `goNextQ` path, and never return to it.
- Skipped → unanswered counts as incorrect in scoring (confirm with `services/unifiedAssessmentService` scoring).
- Optional: a small confirm ("تخطّي بدون إجابة؟") to prevent accidental skips.

### Acceptance criteria
- [x] Skip control visible and works on MCQ and voice questions. *(shared footer control; PR #30)*
- [x] Skipped question never reappears in the same attempt. *(forward-only `goNextQ`)*
- [x] Scoring treats skipped as unanswered/incorrect; totals stay consistent. *(unit-tested in `unifiedAssessmentService.test.ts`)*
- [x] Timer-expiry path and skip path converge on the same `goNextQ` behavior (no double-advance). *(skip stops the timer, then calls `goNextQ`)*

### Files
- `components/UnifiedAssessmentPortal.tsx` (`427–442`, question render `~1040–1070`)
- `services/unifiedAssessmentService.ts` (scoring of unanswered — verify, covered by `src/__tests__/unifiedAssessmentService.test.ts`)

---

## A6 — Completion / exit flow polish
**Track:** ⬜ TODO · **Owner:** — · **Branch·PR:** `item/A6-exit-flow` · **Updated:** — · **ACs:** 0/3  ·  *(tick this item's `### Acceptance criteria` boxes in place as they land; owner adds subtasks here on claim)*

**Type:** Polish · **Priority:** P2 · **Effort:** S
**Recording:** *"There's nothing for me to exit, no 'exit', no 'thank you', no 'you can't retake the attempt' — it just throws them all at me at once, done."* (~2:08–2:25)

### What exists today
- `attempt_done` (`UnifiedAssessmentPortal.tsx:1082–1134`): shows score / cancellation + a retry button when `attempts.length < tok.maxAttempts` ("إعادة المحاولة (N متبقية)").
- `all_done` (`1137–1173`): best score, pass/fail, "شكراً. ستُراجَع نتيجتك من قِبل الإدارة."
- So a completion screen *exists*, but the user experiences the transitions as abrupt and the retry/exit messaging as unclear.

### Goal
A clear, deliberate end-of-assessment experience: explicit **exit/close** control, unambiguous **retry-remaining vs. retry-exhausted** messaging, and a clean thank-you/close — no abrupt "all at once" feel.

### Behavior
- Between attempts (`attempt_done`): clearly show "لديك N محاولة متبقية" *or* "استنفدت محاولاتك — لا يمكنك إعادة الاختبار" when exhausted.
- Final (`all_done`): explicit **"إنهاء / خروج"** action that closes/locks the session so a finished candidate can't re-enter the question flow.
- Smooth the stage transitions (the "بزرامية/all at once" complaint) — confirm each stage is a distinct screen with a deliberate Continue, not an instant jump.

### Acceptance criteria
- [ ] Retry-remaining and retry-exhausted states each show distinct, correct copy.
- [ ] A clear exit/close control exists at the end; after exit the candidate can't resume the questions.
- [ ] Transitions read as deliberate steps, not an abrupt dump.

### Files
- `components/UnifiedAssessmentPortal.tsx` (`1082–1173`)

---

# EPIC B — Anti-cheat on all candidate-facing surfaces

> **Explicit ask:** *"I want to implement the anti-cheat system on all the pages — we implemented it before."* (reference: Image #4, a proctored question with camera monitoring).
> The system is real and production-grade (`proctorCore.ts` + `proctorService.ts`, 13 detected signals, 0–100 integrity score saved per attempt) but is **wired into only 3 components with duplicated boilerplate**, and surveys are completely unguarded.

> **⚠️ Scope to confirm (open question Q1 below):** "all pages" almost certainly means **all candidate-facing test/survey surfaces**, *not* internal admin/builder pages (Projects, Governance Canvas, Admin Panel, Home). This epic assumes the candidate-facing set. Confirm before B3.

## B1 — Extract a shared `useProctor` hook + `ProctorProvider`
**Track:** ⬜ TODO · **Owner:** — · **Branch·PR:** `item/B1-useproctor-hook` · **Updated:** — · **ACs:** 0/4  ·  *(unblocks B3 on merge — flip B3 → ⬜ TODO when this ships; owner adds subtasks here on claim)*

**Type:** Refactor · **Priority:** P1 · **Effort:** L

### What exists today
- Proctoring is wired **inline and near-identically** in three components:
  - `UnifiedAssessmentPortal.tsx` (`222–256` start, `260–274` stop, `509–525` screen request, `901–933` UI)
  - `OnlineAssessmentPortal.tsx` (`175–207` start, `211–218` stop, `268–297` request, `852–881` UI)
  - `VerbalAssessmentScreen.tsx` (`155–163` refs, `199–212` cleanup, `805–836` finish)
- Same refs everywhere: `proctorRef`, `screenStreamRef`, `screenPreviewRef`, `proctorElsRef`, `proctorSummaryRef`, `proctorStartedRef`; same `proctorStatus/proctorIntegrity/proctorAlert` state.

### Goal
One reusable **`useProctor()` hook** (and optional `<ProctorProvider>` / `<ProctorOverlay>`) that owns: camera + screen-share acquisition (gesture-safe), `createLiveProctor` lifecycle, DOM-event listeners (tab-switch, blur, copy/paste, fullscreen), face-detection polling, the status/integrity/alert state, the standard UI tiles + banners, and cleanup. The three portals consume the hook; behavior is identical, code is de-duplicated.

### Acceptance criteria
- [ ] `useProctor` encapsulates the full lifecycle + DOM listeners + cleanup; no proctoring leak across unmount.
- [ ] All three existing portals migrated to the hook with **no behavior change** (same signals, same saved `ProctorSummary`).
- [ ] Gesture-safe `getDisplayMedia`/`getUserMedia` (still invoked from a user click).
- [ ] `tsc --noEmit` clean; `proctorCore` tests still pass; manual parity check on one portal.

### Files
- New: `hooks/useProctor.ts` (+ optional `components/ProctorOverlay.tsx`)
- Refactor: the three portals above
- Unchanged core: `services/proctorCore.ts`, `services/proctorService.ts`

---

## B2 — Multi-monitor / extended-display detection
**Track:** ⬜ TODO · **Owner:** — · **Branch·PR:** `item/B2-multimonitor` · **Updated:** — · **ACs:** 0/4  ·  *(reads best after B1+A2 but not hard-blocked; owner adds subtasks here on claim)*

**Type:** Feature · **Priority:** P1 · **Effort:** M
**Recording:** *"I have two screens — naturally I'd be glancing around — there must be a solution for the two-screen case."* (~1:00–1:08 & 1:52–1:58)

### What exists today
- **No** multi-monitor detection. Screen-share via `getDisplayMedia` lets the user pick a monitor but nothing detects an extended desktop (`UnifiedAssessmentPortal.tsx:509–525`). The proctor's signal set (`proctorCore.ts`) has no `multiple_displays`.

### Goal
Detect when the candidate is on an **extended/multi-monitor** setup and treat it as a proctor signal (warn pre-test, flag during).

### Fix direction
- Use the **Window Management API**: `screen.isExtended` (Chrome 113+) and, with permission, `window.getScreenDetails()` to count screens.
- Add a new signal `multiple_displays` (suggest **severity: high**) to `proctorCore.ts` (`ProctorSignalType`, `SEVERITY_WEIGHT`, `eventAlert`), and emit it from the proctor start path / a periodic check.
- **Pre-test gate** in onboarding (ties to A2): if `screen.isExtended`, warn "يجب فصل الشاشة الثانية قبل البدء" and re-check.
- Graceful degradation where the API is unsupported (don't hard-block; the Gemini Live vision pass may still catch duplicated content visually).

### Acceptance criteria
- [ ] On an extended-display machine, the candidate is warned before starting and a `multiple_displays` alert is recorded if they proceed.
- [ ] Single-display machines see no false positive.
- [ ] Unsupported browsers degrade gracefully (no crash, no hard lock).
- [ ] New signal flows into the integrity score + `ProctorSummary` like other signals.

### Files
- `services/proctorCore.ts` (signal type, weight, alert)
- `services/proctorService.ts` (emit on start / periodic)
- `hooks/useProctor.ts` (B1) — the natural home for the screen check + pre-test gate

---

## B3 — Apply anti-cheat to all candidate-facing surfaces
**Track:** ⛔ BLOCKED (needs B1 🚢) · **Owner:** — · **Branch·PR:** `item/B3-anticheat-surfaces` · **Updated:** — · **ACs:** 0/4  ·  *(do not claim until B1 is SHIPPED; B1's owner flips this to ⬜ TODO on merge)*

**Type:** Feature · **Priority:** P1 · **Effort:** L · **Depends on:** B1

### What exists today
- Proctoring only on the 3 assessment portals. **Surveys/environment-survey surfaces are unguarded.**

### Candidate-facing surfaces to cover (confirm the set — Q1)
- `UnifiedAssessmentPortal.tsx` — ✅ already (migrate to hook)
- `OnlineAssessmentPortal.tsx` — ✅ already (migrate to hook)
- `VerbalAssessmentScreen.tsx` — ✅ already (migrate to hook)
- `AssessmentScreen.tsx` — ❌ not instrumented (`code-explorer` flagged it as bare)
- `PaperAssessmentPortal.tsx` — ❌ audit
- `PublicSurveyScreen.tsx` / `WorkplaceSurveyScreen.tsx` — ❌ environment survey (استبيان البيئة) — currently no proctoring
- `EmployeePortalScreen.tsx` — ❌ audit
- `PublicReviewScreen.tsx` — ❌ audit

> **Note:** Surveys may warrant a *lighter* proctoring profile (DOM-event integrity + optional camera) rather than full screen-share, since they're not graded exams. Decide per surface (Q2).

### Goal
Every candidate-facing assessment/survey surface runs the standard proctoring (via the B1 hook), with a per-surface profile (full vs. lightweight), and records a `ProctorSummary` where applicable.

### Acceptance criteria
- [ ] Each surface in the confirmed set mounts `useProctor` with an appropriate profile.
- [ ] Survey results carry an integrity summary where applicable.
- [ ] No proctoring on internal admin/builder pages (unless Q1 says otherwise).
- [ ] Consistent UI (camera tile, status chip, alert banner) across surfaces.

### Files
- All surface components above + `hooks/useProctor.ts`

---

# Suggested build order (one by one)

1. **A3** — voice recording (P0, blocks the demo). Reproduce → fix → verify with a live proctored exam.
2. **A4** — Puck voice reliability (P1).
3. **A5** — skip question (P1, small win).
4. **A2** — onboarding rules/prohibitions (P1) — also seeds B2's pre-test gate.
5. **A1** — industry→job-titles suggestion (P1).
6. **B1** — `useProctor` refactor (P1, foundation for B2/B3).
7. **B2** — multi-monitor detection (P1, builds on B1 + A2).
8. **B3** — roll anti-cheat to all surfaces (P1, builds on B1).
9. **A6** — completion/exit polish (P2).

Each ships as its own **open PR** against `main` — never merged, never deployed (repo rule).

---

# Open questions (please confirm)

- **Q1 — Anti-cheat scope:** Does "all pages" mean **all candidate-facing assessment + survey surfaces** (my assumption), or literally every route including internal admin/builder pages?
- **Q2 — Survey proctoring depth:** For environment surveys (استبيان البيئة), full proctoring (camera + screen-share) or a **lightweight** profile (DOM integrity only / camera optional)?
- **Q3 — Job-title generation (A1):** Static curated sector→titles map (instant, offline) or Gemini-generated per company? (Recommendation: static for prefill, Gemini behind a "Suggest" button.)
- **Q4 — Web-Speech fallback (A4):** If Puck/Gemini TTS is unavailable, prefer the **robotic browser voice** or **no audio + a visible notice**?
- **Q5 — Multi-monitor enforcement (B2):** **Hard-block** starting on an extended display, or **warn + flag** and let them proceed (recorded as a violation)?

---

## 🧾 Activity log — append-only (newest at the BOTTOM; never edit or delete a prior line)

**Conflict rule:** two sessions appending at once make a trivial conflict — **keep BOTH lines** (any order; timestamps disambiguate). **Never** resolve this log with `git checkout --ours/--theirs`. To minimise collisions, append your log line in the **same tiny commit** as the board-row change it describes.

Format: `- <HH:MM> UTC · <SID> · <ITEM> · <verb> · <short note>`
Verbs: `claim · wip · check · pr-open · shipped · verify · park · reclaim · unblock · lost-race · note`

- 06:05 UTC · s-0628-0558-main · A3 · shipped · ScriptProcessorNode resume-assert + native-rate fallback + VU meter; committed 709e02a, deployed to prod
- 06:06 UTC · s-0628-0558-main · A3 · verify · released for live VU-meter check in a real proctored exam (camera + screen-share); anyone may claim the verification
- 16:50 UTC · s-0628-0558-main · — · note · tracking system added to this PRD (coordination header, claims board, per-item Track lines, this log)
- 14:53 UTC · s-0628-1453-525d · A5 · claim · skip-question control (MCQ + voice), one-way no-return; branch item/A5-skip-question
- 15:04 UTC · s-0628-1453-525d · A5 · pr-open · PR #30 — goSkipQ + two-step confirm; tsc/build clean, 13/13 tests; ACs 4/4 (awaiting maintainer merge)
- 15:09 UTC · s-0628-1453-525d · A5 · shipped · PR #30 merged (3c7e580) + deployed to prod (hawkamah.web.app); skip control live
- 15:20 UTC · s-0628-1453-525d · A2 · claim · pre-test onboarding/rules step; branch item/A2-onboarding-rules
- 15:15 UTC · s-0628-1514-f086 · A4 · claim · Puck-voice reliability — make Puck path reliable, demote/gate Web-Speech fallback, audit proctor-alarm voice; branch item/A4-puck-voice
