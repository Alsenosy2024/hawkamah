# CI/CD — Hawkamah

Two GitHub Actions workflows give the team a safe, automated path from PR to production.

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `firebase-hosting-pull-request.yml` | every pull request | Lint (`tsc`) → test (`vitest`) → production build. For branches **inside this repo** it then deploys a temporary **preview channel** and comments the URL on the PR (expires in 7 days). Fork PRs run the gate but skip the deploy. |
| `firebase-hosting-merge.yml` | push / merge to `main` | Same gate, then deploys to the **live** site (`hawkamah.web.app`). Hosting only — never touches Firestore or Functions. |

## Branch model

1. Branch off `main`, push, open a PR.
2. CI runs the gate and posts a preview URL — review the running app there.
3. Merge to `main` → it auto-deploys to production.

Protect `main` (Settings → Branches) and mark the **Verify + preview deploy** check as required so nothing merges without a green build.

## Required secrets

Set these once in **Settings → Secrets and variables → Actions** (needs repo admin):

| Secret | Value |
|--------|-------|
| `FIREBASE_SERVICE_ACCOUNT_HAWKAMAH` | JSON key for a service account with the *Firebase Hosting Admin* + *Firebase Viewer* roles on project `gen-lang-client-0579241284`. |
| `GEMINI_API_KEY` | The referrer-locked production Gemini key used by the build (`vite.config.ts`). |

Until `FIREBASE_SERVICE_ACCOUNT_HAWKAMAH` is set, deploy steps **skip cleanly** (the gate still runs), so the pipeline is never red just because a secret is missing.

### Minting the service account

```bash
SA=github-hawkamah-deploy@gen-lang-client-0579241284.iam.gserviceaccount.com
gcloud iam service-accounts create github-hawkamah-deploy \
  --project gen-lang-client-0579241284 \
  --display-name "GitHub Actions - Hawkamah Hosting Deploy"
gcloud projects add-iam-policy-binding gen-lang-client-0579241284 \
  --member "serviceAccount:$SA" --role roles/firebasehosting.admin
gcloud projects add-iam-policy-binding gen-lang-client-0579241284 \
  --member "serviceAccount:$SA" --role roles/firebase.viewer
gcloud iam service-accounts keys create sa.json --iam-account "$SA"

gh secret set FIREBASE_SERVICE_ACCOUNT_HAWKAMAH -R Alsenosy2024/hawkamah < sa.json
gh secret set GEMINI_API_KEY -R Alsenosy2024/hawkamah   # paste the key when prompted
rm sa.json   # never commit the key
```
