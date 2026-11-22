# Operating notes for the repaired app

This is a tested repair candidate, not a school rollout. The owner said existing records are test data. No deletion, account replacement, default-branch merge, school cutover or paid plan was authorized or performed.

## What the free setup can and cannot promise

The isolated test uses Firebase Spark plus Cloudflare's free hosting path. It is suitable for a small initial deployment with usage review, not an unlimited or outage-free service.

Current vendor documentation lists these Firestore free quotas: 1 GiB storage, 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day and 10 GiB outbound transfer/month. Daily Firestore quotas reset around midnight Pacific time. Real-time listeners use document reads on initial load and changes; opening many sessions and retaining long histories increase usage. This app currently subscribes to whole permitted collections, so a large history needs pagination/archiving work before promising larger scale.

Cloudflare Workers Free lists 100,000 requests/day, 10 ms CPU/request, 50 subrequests/request and 128 MB memory. Network waits do not count as CPU, but large JSON backups, validation and authentication can approach the CPU limit. Hosted 100-item approval, concurrency and small complete restores passed. That is evidence for those tested workloads, not a benchmark of every possible 4 MiB restore. Free-tier exhaustion or a CPU limit can interrupt service. No paid upgrade is automatic or approved by this work.

Sources checked on 2026-11-22:
- https://firebase.google.com/docs/firestore/quotas
- https://firebase.google.com/docs/firestore/pricing
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/

## Explicit application bounds

- A requisition accepts 1 to 100 distinct items.
- An ordinary administrator patch accepts up to 150 changes.
- Ordinary request bodies are limited to 512 KiB. Complete restore bodies are limited to 4 MiB. A body limit is not a guarantee that the host can process every dataset of that size.
- Password input is never stored or logged by the broker. It is sent only to Firebase for verification over HTTPS, followed by a scoped custom session.
- The broker allows up to 10 attempts per known account per five-minute time bucket, persisted transactionally. It has a further 100-attempt backstop per running instance per five-minute bucket. This is not a global per-IP defense; a larger public deployment should add host-level abuse protection. Correct sign-ins also count toward these limits.
- Directory minimization is one atomic administrator operation for at most 300 directory records. It changes directory metadata only, preserves protected accounts and disables orphan directory entries rather than deleting records.
- Public directory API responses contain only a display name and opaque selector. Raw Firestore directory reads require an active administrator. Teacher browsers cannot read that collection directly. An authenticated administrator can access the private account-management directory.
- Staff display names remain enumerable before login because this preserves the owner's requested name dropdown. The selector is an opaque Firebase UID, not a password or bearer credential.

## Recovery and cutover

The app's administrator JSON export contains the application datasets, not passwords or Firebase Auth credentials. Complete restore preserves protected accounts and existing audit history, rejects stale/incomplete/tampered backups and uses an idempotency record. It is not a Firebase-managed database backup.

Firebase-managed backups, point-in-time recovery and managed restore features do not have free usage under the documented free quota. They were not enabled. An owner-operated export before important changes is the current recovery route. No ongoing backup or alerting responsibility has been silently created.

Before an approved school cutover, record the exact deployed frontend/backend/rules versions, save an application export and preserve the existing repository and configuration. Set up or verify the intended administrator securely, without reusing the synthetic test credentials. With no real records to migrate, clean secure collections can be introduced without deleting legacy test records. Do not import the pilot's synthetic accounts into school use.

After cutover, acceptance checks should cover fresh administrator/teacher sign-in, a small request and approval, visible stock change and a backup/export. A rollback must use a matched secure frontend, backend and rules version. Do not reopen legacy public rules or restore client-side passwords to make an old frontend work. If acceptance fails, preserve data and restrict the new service while the approved version is restored.

## Dependency status

Captured audits show zero production advisories and zero high/critical advisories across the whole tree. Fourteen moderate advisories remain in development-only Firebase CLI dependencies. They are recorded, not represented as a clean whole-tree audit, and are not a reason to delay the functioning runtime indefinitely.
