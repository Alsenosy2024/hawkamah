# CI/CD — Hawkamah

A lightweight, secret-free pipeline for team collaboration: GitHub verifies every
change, and a maintainer ships to production from their machine.

## How it works

| Stage | Where | What |
|-------|-------|------|
| **Verify** | GitHub Actions (`ci.yml`) | On every pull request and every push to `main`: lint (`tsc`) → test (`vitest`) → production build. A red gate blocks the merge. |
| **Merge** | Maintainer | Approved PRs are merged into `main` (`gh pr merge` or the GitHub UI). |
| **Deploy** | Maintainer's machine | `npm run deploy` builds and ships to **hawkamah.web.app** via the Firebase CLI. |

Deploys are intentionally **manual**, not in CI: production credentials (the
Firebase login and the Gemini key) stay on the maintainer's machine and never
need to be uploaded to GitHub.

## Day-to-day flow

```bash
git checkout -b my-change          # branch off main
# ...work...
git push -u origin my-change
gh pr create                       # open a PR — CI runs the gate
# ...review, get a green check...
gh pr merge --squash --delete-branch   # merge from anywhere with repo write access
npm run deploy                     # a maintainer ships main to production
```

## Deploying

Requires the Firebase CLI logged in (`firebase login`) with access to project
`gen-lang-client-0579241284`, and a local `.env` containing `GEMINI_API_KEY`
(the referrer-locked production key — see `.env`, which is gitignored).

```bash
npm run deploy        # == vite build (prod) + firebase deploy --only hosting
```

Only **hosting** is deployed — never Firestore rules or Functions.

## Optional: enable CI deploys later

If you ever want GitHub to deploy automatically, add two repo secrets
(`FIREBASE_SERVICE_ACCOUNT_HAWKAMAH`, `GEMINI_API_KEY`) and reintroduce a
deploy job — the `ci.yml` build step already reads `GEMINI_API_KEY` if present.
