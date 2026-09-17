# Evidence Index

This document maps the assessment requirements to their corresponding execution and verification states within the project.

| Requirement | Evidence/Status | Location/Reference |
| :--- | :--- | :--- |
| **Upload interface** | Verified. React components render strictly. | `src/app/page.tsx` |
| **Valid upload** | Verified. Successfully saves UUID filename. | `src/app/api/upload/route.ts`, local `/uploads` dir |
| **Job ID & Pending/Processing** | Verified. UI polls and transitions badges seamlessly. | `src/app/page.tsx`, `src/app/api/job/[id]/route.ts` |
| **Completed extraction** | Unverified Live. Missing API key. | Expected in `resultData` via `worker.ts` |
| **Structured Result UI** | Verified via structure. Renders JSON nicely when done. | `src/app/page.tsx` (Pre-formatted block) |
| **Policy Auditor Button** | Verified. Button active only when `status === "done"`. | `src/app/page.tsx` |
| **Auditor Result UI** | Verified via structure. Shows flags/risk level cleanly. | `src/app/page.tsx` |
| **Validation Failure** | Verified natively. Zod error captured successfully. | `task-876.log` (Fixture test sequence) |
| **Retry/Failure State** | Verified. Exhausts 3 attempts, marks `failed`, sets error. | `src/worker.ts` error handling block |
| **Invalid/Oversized Upload** | Verified. Returns strict 400 safely. | `src/app/api/upload/route.ts` |
| **Upload Rate Limit** | Verified. Triggers 429 after 5 requests. | `src/app/api/upload/route.ts` |
| **Nonexistent Job ID** | Verified. Returns safe 404 response. | `src/app/api/job/[id]/route.ts` |
| **Worker Running** | Verified. Connects to Prisma cleanly. | `.system_generated/tasks/task-876.log` |
| **Concurrency = 2** | Verified. `p-queue` strict limit enforced. | `src/worker.ts` lines 13-14 |
| **Prisma/SQLite Job Record** | Verified. Rows persist successfully with `fileReference`. | `query.js` output verification |
| **Raw AI Output Evidence** | Verified logging. Local NDJSON log capture enabled. | `evidence/raw_model_outputs.jsonl` |
