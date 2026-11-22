# Regent Lab secure repair

Latest tested review checkpoint: 2026-11-22, private sign-in broker and teacher-list refresh included. This is not a school deployment. The default branch and original school website were not changed. Existing protected accounts were not replaced, and no billing was enabled.

## Try the working isolated version

https://regent-lab-backend-pilot.pages.dev/review/

Teacher entry: https://regent-lab-backend-pilot.pages.dev/review/?mode=teacher

This is the existing `regent-lab-pilot` synthetic Firebase project. Use only the separately supplied synthetic administrator/teacher credentials. Administrator username: `synthetic-admin@regent-lab-pilot.invalid`. The display name `Synthetic Administrator` also works. The password is supplied only through its secure copy link. The pilot target guard rejects the school project. No passwords or server credentials are in this source package.

## Canonical source

`index.html` is the reviewed frontend. Its generic secure backend URL is deliberately unset until a school target/cutover is approved. `secure-client.mjs` uses Firebase browser SDK 13.4.0 and the private broker. `secure-backend/` contains readable backend modules, rules, tests, the dependency lock and the guarded synthetic pilot entry point. `assets/`, `tailwind.js` and `qrcode.js` are local visual dependencies.

The public sign-in API returns names and opaque selectors only. Password verification and login-address/role lookup are server-side. Teacher dropdown selection is preserved. Raw directory reads require an active administrator. The existing pre-login Refresh Teacher List control now reloads only the public list.

`build-pilot-ui.mjs` creates isolated pilot assets from the canonical frontend and applies only the synthetic pilot configuration. It does not deploy anything. School/backend entry points are review material, not permission to change a live service.

## Verification

- 41 unit, broker/security, crypto and restore checks passed.
- 12 real Firestore/Auth/portable-REST emulator checks passed, including custom-token exchange, public-field minimization, teacher denial of private directory access and account-preserving minimization.
- Actual Chrome UI suite passed with both teacher and administrator broker login, zero direct browser email/password-provider requests, pre-login list refresh, request/approval, stock changes, loans/losses/schedule/print, stale-write rejection and logout privacy.
- The same UI suite covers two consecutive complete restores, cross-session listener re-sync, a later save, incomplete/tampered backup rejection, password-free export and preservation of protected accounts and prior audit history.
- Hosted pilot evidence separately proves persistent 100-item approval/retry, competing concurrent approvals, full transactional restore and teacher/admin live request approval.
- Fresh hosted administrator and teacher broker sessions were verified as Firebase custom sessions with unchanged UIDs. The pre-login endpoint returned only name/selector. Anonymous and authenticated-teacher direct directory reads both returned 403 after the published rules were checked against the tested source.

Test logs and dependency audits are in `test-results/`. The final teacher-list label/refresh-only change was tested through the actual UI after the broker tests.

## Reproduce

Use Node 22+, Java 21+ and Google Chrome at `/usr/bin/google-chrome`, or adjust the UI test's browser path.

From `secure-backend/`:

```sh
npm ci
npm test
npm run test:emulator
npm run test:ui
```

Tests use local `demo-` emulator projects. Never point them at school data. The package contains the complete local assets and dependency lock needed for reproduction.

## Launch boundary

The owner's latest clarification is that current records are test data. There is no valuable-record migration to perform. Actual school cutover still needs the intended target and administrator/account setup to be approved. Preserve the current source/configuration and legacy test records rather than deleting or silently replacing them. Synthetic credentials are not school credentials.

See `OPERATIONS.md` for explicit free-tier capacity, sign-in limits and recovery/rollback conditions. There is no unlimited-capacity, automatic-backup or outage-free claim.

Captured dependency audit: zero production advisories, zero high/critical overall, and 14 moderate advisories in development-only Firebase CLI dependencies. The runtime audit is clean; the whole development tree is not described as clean.

## Administrator login compatibility

The administrator broker accepts the existing private Firebase email alias as well as the display name. Email aliases are looked up privately and never added to the public directory. A fresh final hosted login using the exact email username shown in the owner's screenshot and the unchanged saved password passed. The vault username matches that email alias; no password reset occurred.
