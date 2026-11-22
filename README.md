# Regent Lab secure repair, review branch only

This is the integrated repair source checkpoint of 2026-11-22. It is not a school deployment. Main and the live school website were not changed. No school records were migrated, no billing was enabled.

## Canonical source

`index.html` is the reviewed frontend, with the secure backend deliberately unset. `secure-client.mjs` is its authentication/transaction client, using Firebase browser SDK 13.4.0. `secure-backend/` contains the readable backend, guarded synthetic pilot entry point, Firestore rules and automated tests. `assets/`, `tailwind.js` and `qrcode.js` are local visual dependencies. No legacy credential-bearing source or service-account key is included.

## Tested pilot

https://regent-lab-backend-pilot.pages.dev/review/ is the isolated synthetic full UI. Its Firebase project is `regent-lab-pilot`, Spark plan. `pilot-connected.mjs` rejects school/wrong-project targets. `build-pilot-ui.mjs` copies canonical frontend source and applies only the isolated pilot configuration into `pilot-ui-assets/review/`. This does not deploy anything. The generic school/backend entry points remain unconfigured review material.

## Verified behavior

33 unit/crypto/restore checks, 11 real-Firestore/Auth/REST emulator checks, and the complete Chrome UI emulator suite passed after dependency upgrades. The UI suite includes two consecutive restores, cross-session listener re-sync, a post-restore save, stale inventory form rejection, incomplete/tampered backup rejection, prior audit/account preservation, password-free export, teacher/admin request approval, loans/losses/schedule/print and logout privacy.

Hosted pilot checks separately proved real Firebase login, a persistent 100-item approval/retry, teacher administrator denial, competing concurrent approvals with exactly one winner, full transactional restore, and a real teacher UI request/admin approval with stock 9 to 6 and teacher live update. The final hosted UI restore used explicit Restore/Cancel confirmation, and both open sessions reached epoch 2 with the approved request and stock intact.

## Reproduce

Use Node 22+, Java 21+ and Google Chrome at `/usr/bin/google-chrome` (or adjust the UI test executable path). From `secure-backend/`: `npm ci`, then `node --test test/domain.test.mjs test/restore.test.mjs test/portable-crypto.test.mjs`, `npm run test:emulator`, and `npm run test:ui`. The emulators are restricted to local demo projects. Never point tests at a school database.

## Dependencies

Firebase Admin 14.5.1, Firebase CLI 15.37.0, test/browser SDK 13.4.0, rules testing 6.0.0; gRPC 1.14.7 is pinned to the patched compatible 1.x release. Latest captured audit: 0 production advisories, 0 high/critical across all packages. Fourteen moderate advisories remain in development-only Firebase CLI dependencies. Exact audit output and test logs are under `test-results/`. Do not describe the complete development tree as clean.

## Still required before school-ready proposal

- Minimize the public synthetic login directory before introducing real staff: preserve the requested name dropdown with display name plus opaque selector; move role/login-identifier resolution to a tested server-side sign-in broker. Current pilot directory still includes synthetic role/UID/login identifiers. Public visibility of staff display names is a separate owner privacy decision.
- Finish review of remaining development-only moderate dependency advisories, operational limits, monitoring, rate limits and recovery/rollback.
- Inspect the existing school schema and exact data-migration mapping with the owner. Preserve a verified backup and agree account/teacher mapping. No school data has been moved by this repair.
- Obtain explicit school rollout authority, target configuration and acceptance plan. Review branch is not approval to merge/deploy to main.

The source is a pilot-tested repair, not an assertion that all production/privacy work is finished.
