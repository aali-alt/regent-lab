# Regent Lab checkpoint 2026-11-23 (post-upgrade)

This checkpoint matches the build deployed to production on 2026-11-23 (~00:56-00:59 EET).

## Deployed artifacts
- Backend worker `regent-lab-backend`: version f4bcb63d-085d-413a-b488-07a879d346c8, deployed via wrangler from `deploy-workers/` (bundle freshly built from `secure-backend/school-production-worker.mjs` with esbuild --bundle --preserve-symlinks --format=esm --platform=browser). Cron trigger `0 22 * * *` intact; static assets (18 + updated client) preserved.
- Frontend `index.html`: 317813 bytes, sha256 3afa81995a8b85a5f21b4fda2d9cd88b4257be20aeb0d5a2f24b3d5ff6ecf6ec, live on https://aali-alt.github.io/regent-lab/ (GitHub Pages, branch main), verified byte-identical to this copy.

## New in this build
- True per-bottle stock records: label, capacity, opened date, per-bottle cabinet/shelf with item-level fallback. Validation: remaining never exceeds capacity (BOTTLE_OVER_CAPACITY, backend + client guard).
- Read-only item detail card, cabinet detail card (filters by effective bottle location, "X of Y bottles here"), booking detail card with Move Booking (conflict-checked /requests/amend) and pending-request cancel/delete (/requests/cancel).
- Explicit bottle pickers on approval, manual loan and loss flows; loans record batchAllocations; returns restore the exact amount to the source bottle.
- Legacy unlabeled batches stay unconfirmed containers (never announced as physical bottles).

## Verification
- 62/62 backend unit/integration tests pass (node --test secure-backend/test/*.test.mjs).
- Emulator UI evidence (firebase emulator + Playwright, demo project only, no production writes): see verification/2026-11-23-bottle-*.png and secure-backend/test/ui-bottle-evidence.mjs. Covers: over-capacity rejection, two identified mL containers in different cabinets, cabinet filtering, explicit selected-container dispense of 100 mL and exact restore, mobile viewport rendering.
- Live checks: /health ready, /requests/amend + /requests/cancel return 401 unauthenticated, secure-client.mjs serves new client, live site hash matches this checkpoint.

## Access notes
- Deployments used a temporary account-scoped "Edit Cloudflare Workers" API token, created for each deploy and deleted immediately after (verified absent from the token list).
