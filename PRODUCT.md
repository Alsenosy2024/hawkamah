# Product

## Register

product

## Users

Three distinct audiences share one system, each in a different mindset:

1. **Governance operators / consultants** (the Ailigent / Dr. Ahmed Alsenosy practice and client HR leads). They work in the **Admin Hub (بوابة الإدارة)** and **Governance Center**: ingesting company documents, building governance models (policies, procedures, KPIs, job descriptions, RACI, risk registers), generating department packages, and configuring assessments. Context: focused, multi-session, desktop, expert users moving large amounts of structured information. They need power, density, and trust in the output.

2. **Candidates / employees being assessed** (بوابة الموظف and the exam portals). They take competency tests (MCQ), **interactive AI voice interviews** with an on-screen interviewer ("محاور معتمد"), paper assessments, and workplace-environment surveys, under **live AI proctoring** (camera + screen, integrity score, per-question alerts). Context: high-stakes, time-pressured, often anxious, single-sitting, may be on a laptop in a real office. They need calm, clarity, and a sense of fairness.

3. **External managers / reviewers** who open a shared token link to configure a paper assessment, or to read results and integrity reports. Context: occasional, link-driven, outcome-focused.

## Product Purpose

Hawkamah (حوكمة), branded **Ailigent.ai**, is an Arabic-first AI platform for **institutional governance and competency assessment**. It does two linked jobs: (1) turn a company's real documents into a structured governance model, and (2) measure the people inside that company against it through AI-generated, methodology-grounded assessments and interviews.

It is explicitly credibility-driven: assessments are built on named frameworks (EFQM European excellence, Birkman, Holland RIASEC, PsychTech, Bloom's cognitive taxonomy), questions are scenario-based and tied to the organization's own reality, and interviews are monitored by live AI proctoring that produces a defensible integrity score. Success = an operator trusts the model and report enough to make a real org-design or hiring decision, and a candidate experiences the process as rigorous and fair.

Stack: React 19 + Vite + TypeScript + Firebase, with Google Gemini (text, voice/Live, embeddings) as the intelligence layer. Arabic (RTL) primary with an English toggle.

## Brand Personality

Three words: **authoritative, rigorous, calm.** The voice is that of a senior governance consultant: precise, methodology-literate, never flippant. It earns trust by showing its work (frameworks, grounding in the company's own data, transparent integrity signals) rather than by decorating. For candidates the same authority must read as steady and fair, not intimidating. Bilingual by nature: Arabic carries the weight, English is a clean equal alternate.

## Anti-references

- **The generic Google AI Studio / starter-template look it currently ships with** (the repo's own README is the AI Studio boilerplate). Default teal-on-white SaaS, evenly-padded identical cards, hero-metric blocks.
- **Consumer "fun" AI products** (playful gradients, mascots, rounded-everything, emoji-led UI). This is an instrument of institutional judgment, not a toy.
- **Generic HR-tech dashboards** (dense gray tables, Bootstrap-era chrome, navy-and-blue corporate clip-art).
- **Arabic-as-an-afterthought**: Latin-first layouts with Arabic bolted on, mismatched Arabic fonts, broken RTL. Arabic must look native and intentional, not translated.
- **Surveillance-state aesthetics** for the proctoring UI (red alarms everywhere, "you are being watched" hostility). Integrity must feel fair and transparent, not threatening.

## Design Principles

1. **Institutional trust over decoration.** Every screen should read as credible enough to base a governance or hiring decision on. Show the rigor (frameworks, grounding, integrity) plainly; never let ornament undercut authority.
2. **Arabic-first, truly.** RTL and Arabic typography are the primary design target, not a localization layer. The English mode is an equal alternate, not the "real" design.
3. **Two registers, one system.** Operator surfaces (Governance Center, Admin Hub) earn density and power; candidate surfaces (interviews, exams, surveys) earn calm, focus, and guidance. The shared visual language must flex between both without feeling like two products.
4. **Calm under scrutiny.** Assessment and proctoring are high-stakes for the person on camera. Reduce anxiety: clear progress, one task at a time, integrity signals that inform rather than threaten.
5. **Earned confidence, not claimed.** Differentiators (methodology-grounded questions, live AI proctoring, governance modeling) are surfaced as evidence the user can see and verify, not as marketing badges.

## Accessibility & Inclusion

- **WCAG 2.1 AA** as the baseline: contrast, focus states, keyboard navigation, semantic structure.
- **RTL + Arabic** is a first-class accessibility concern: correct bidi, logical properties, Arabic-legible type sizes and line-height.
- **Bilingual parity**: every screen fully usable in Arabic and English; the toggle must never strand a user in a half-translated state.
- **Reduced-motion** respected, especially on high-focus assessment screens.
- **High-stakes fairness**: proctoring/integrity UI must be understandable to a non-technical candidate, with clear, non-punitive language; graceful degradation when camera/screen permissions are limited.
- Color must not be the only carrier of meaning (integrity status, correctness, alerts also use text/icon).
