# ADR 0006: Uploads and scanning

**Status:** On 2026-11-06 the owner accepted the choices below, now [decisions 50 to 59](../spec/PRODUCT.md#decisions-needed). The scanner is conditional on a spike. The billed staging resources, and so the spike, haven't been approved. The design that follows from the choices is **proposed** and isn't built. The rules people see are in the [upload policy](../spec/UPLOAD-POLICY.md), and the order of work is in the [M2 plan](../m2-plan.md).

## The owner's choices

| # | Choice | Accepted | Why |
| --- | --- | --- | --- |
| 50 | Limits and types | 100 MB per file, 5 GB per room. Documents, images, text, code, presentations, video and zip. No executables or password-protected files | 100 MB is the request limit on Cloudflare's Free and Pro plans |
| 51 | Scanner | ClamAV in Cloudflare Containers, if the spike passes. Otherwise a hosted API with a no-retention contract, and never one that shares samples | Files stay in the account. Cloudflare's own upload scanning needs an Enterprise plan with a paid add-on |
| 52 | Previews | Download only in M2 | No content domain is needed, and no agent-written HTML runs near the app |
| 53 | Input assets | Owner, admin, member and Coordinator upload. Whole-room viewers see all, and guests see only assets linked to their tasks | Guests get what their work needs |
| 54 | Expected outputs | Owner and admins define them, requesters link tasks, and the lead comes later. All participants see titles and status | Outputs are the room's goal |
| 55 | External links | Kept, labeled "External link, may change since approval" | M0 and repository work depend on them, but they can't be exact-version |
| 56 | Retention | Files and messages last the room's life during the preview, and archiving keeps them | Rooms can't be deleted yet, so the quota caps cost |
| 57 | Takedown | Owner, admin or a Podster operator can remove a file's bytes, keeping its record and hash | It's the one exception to "submitted artifacts are always kept" |
| 58 | Oversight | Org admins see file names and status, not bytes, at first | Decision 7 covers tasks and inboxes, not files |
| 59 | Export and legal terms | Deferred until before public rooms | Only private pilots run until M4 |

## Context

Artifacts are HTTPS links today. `artifact` holds `uri` and `label`, and `Verify` checks `submission_no` but records nothing about what it approved. No upload route, bucket or scanner exists.

Two facts from Cloudflare's documentation shape the design:

- An R2 presigned URL can't enforce a size. It's limited to `GET`, `HEAD`, `PUT` and `DELETE`, form uploads with a policy aren't supported, and it can only pin a content type. It also works for anyone who holds it until it expires, so it can't be revoked when someone leaves.
- A request body to a Worker is limited by the domain's Cloudflare plan: 100 MB on Free and Pro. This repo hasn't checked which plan `podster.dev` is on.

## Decision (proposed)

### Uploads and downloads pass through our Workers

Both go through the gateway and the private API, using an R2 binding. The bucket has no public access and no S3 keys exist.

This keeps every rule in Rust, enforces size while streaming and rechecks authority on each use. The cost is that files can't be larger than the request limit without multipart work later.

Uploads:

1. `create_upload` is an ordinary command. Policy checks the caller, the room's quota is reserved, and a `pending` `stored_object` row and a short-lived upload grant commit in one transaction.
2. The file streams to R2 under an immutable key scoped by room. A Worker has 128 MB of memory, so nothing buffers the whole file, including hashing.
3. Completion checks the size and hash, moves the object to scanning and queues the scan.

Abandoned uploads give their space back through a sweep in the room's alarm, and an R2 lifecycle rule clears incomplete data.

Downloads ask the room's Durable Object first. A link is checked against the room again each time it's used, so it needs no separate revocation. Responses are attachments with `X-Content-Type-Options: nosniff` and a cleaned filename. Filenames are agent content, so they stay out of logs and events.

### Scanner

A queue consumer hands the object to a ClamAV Container and reports the result to the room, which records it after rechecking that the object exists. A result is recorded even if the room was archived in between.

The Container runs hostile input, so it holds no secrets and has no access to rooms, and its only outbound traffic is for signature updates. Anything it can't read is `blocked`. An object with no result after an hour becomes `failed`.

The spike has to show, on staging, that:

- A 100 MB file streams through web, gateway and API to R2.
- ClamAV fits a Container instance, including its signature memory, cold start and zip bombs.
- Signatures can be kept up to date.

If it fails, the fallback in decision 51 applies, and the owner hears before anything else is built.

### Exact-version review

Extend `artifact` and `submission` instead of adding the `artifact_version` table the architecture first drew. Submissions are already numbered and immutable, so a submission number is the version.

- `artifact` gains an optional `object_id`, and a row has either that or a link.
- `verify_task` already names `submission_no`. It also records the approved submission on the task, in the same transaction. This part is built, as `approved_submission_no`, and needed no storage. A task completed before it has its latest submission recorded, the only one that could have been approved.
- `crates/core` gets "all files clean" through its existing `observed` input, and refuses approval without it. Core stays pure.
- An object can be attached only by the person or agent who uploaded it, on a task in the same room.

A later submission starts unreviewed, so an approved badge can't move onto different content.

### Expected outputs

A task may name an expected output. Approving it makes the output Ready and links that approved submission. Several tasks can name one output, such as a follow-up, and the latest approval is its current version. Cards show the count from a listing read model that never authorizes.

### Removal

Removing a file deletes its bytes and sets a tombstone on `stored_object`, keeping its hash and who removed it. An approved submission keeps its approval and shows the file was removed.

## Consequences

- No content domain, Public Suffix List entry or S3 credentials are needed for M2.
- Files over 100 MB aren't possible until multipart upload is designed.
- A pilot file a person needs to look at has to be downloaded first.
- Scanning only catches known malware, which is why the policy says "No known malware found".
- The most storage one organization can use is about 100 GB, from 20 rooms at 5 GB each.

## Cloud resources this needs (not approved)

The owner approves these, and none exist:

- A private R2 bucket for staging.
- A scan queue and a dead-letter queue.
- Cloudflare Containers and a small scanner Worker, billed above the Workers Paid allowance.
- The same again before production.

## Proposed details to settle in review

- The exact file formats behind each allowed category, including whether macro-enabled Office formats count as executables.
- The lifetime of an upload grant and of a download link.
- How oversight's "name and status" appears in `getOverseenTask`.
- The operator's takedown route, which has to be a recorded command and not a change to the database by hand.
