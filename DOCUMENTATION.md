# AI Expense Extraction System Documentation

## 1. What This Is
This project is an AI-powered expense extraction and auditing system built as a web application. It accepts receipt images, processes them via a background worker queue, and extracts structured data using Google's Gemini AI, allowing users to optionally run a secondary policy audit on the results.

The system uses a single-model, dual-role architecture powered exclusively by `gemini-3.6-flash`. By utilizing distinct system prompts and strict structured JSON outputs validated through Zod, the application securely and resiliently isolates the Extraction Engine from the Policy Auditor while enforcing strong concurrency, rate limiting, and retry constraints.

## 2. How To Run It
1. **Clone the repository:**
   ```bash
   git clone <repository_url>
   cd assessment-3-ai-integration
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Configure environment variables:**
   Copy the provided `.env.example` file to create a new `.env` file:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and add your genuine Gemini API key as `GEMINI_API_KEY`. *(Never commit your real key to version control).*
4. **Database Setup:**
   Run Prisma migrations to initialize the local SQLite database schema:
   ```bash
   npx prisma db push
   ```
5. **Start the application:**
   The project uses `npm-run-all` to boot both the Next.js server and the background worker simultaneously:
   ```bash
   npm run dev
   ```
6. **Access the web app:**
   Open your browser and navigate to `http://localhost:3000`.

## 3. The Flow, Step By Step
1. **Upload Initiation:**
   - **What the user does:** Selects a JPG/PNG receipt and clicks "Process Receipt".
   - **What the frontend sends:** A `POST` request with the `FormData` containing the file to `/api/upload`.
   - **What the server does:** The `src/app/api/upload/route.ts` validates the file size/type, rate-limits by IP, saves the image to the local `/uploads` directory, creates a `pending` job in the SQLite database storing only the file path string, and returns the `jobId` to the frontend.

2. **Status Polling:**
   - **What the user does:** Waits for the processing to complete (the UI displays a spinning indicator).
   - **What the frontend sends:** A `GET` request every 3 seconds to `/api/job/[id]`.
   - **What the server does:** The `src/app/api/job/[id]/route.ts` queries the database for the current job status (`pending`, `processing`, `done`, or `failed`) and returns it.

3. **Background Extraction:**
   - **What the user does:** N/A (background process).
   - **What the frontend sends:** N/A.
   - **What the server does:** The `src/worker.ts` script polls for `pending` jobs, picking them up via a `p-queue`. It reads the image, calls the Gemini API with the Extraction system prompt, enforces a timeout, parses the structured JSON output with Zod, and updates the database to `done` with the result, or triggers a retry/backoff loop on failure.

4. **Policy Audit:**
   - **What the user does:** Clicks the "Run Policy Auditor" button on the completed extracted result.
   - **What the frontend sends:** A `POST` request with the `jobId` to `/api/audit`.
   - **What the server does:** The `src/app/api/audit/route.ts` applies a separate rate limit, fetches the validated JSON from the database, and calls the Gemini API with the Auditor system prompt. It parses the result with Zod and returns the final audit report directly to the client.

## 4. The Data Model
The database consists of a single SQLite table: `Job`.
- `id` (String, UUID, Primary Key): Uniquely identifies the job safely.
- `fileReference` (String): Stores the lightweight relative path to the image in `/uploads`. This constraint prevents database bloat and memory exhaustion that would occur if storing raw BLOB data.
- `status` (String): Tracks strict state (`pending`, `processing`, `done`, `failed`). This single-source-of-truth constraint prevents race conditions and ensures jobs are tracked accurately.
- `resultData` (String, nullable): Stores the final validated JSON string output from the AI.
- `errorMessage` (String, nullable): Captures the exact reason for terminal failure.
- `attempts` (Int, default 0): Tracks retry counts to prevent infinite loops (capped at 3).
- `createdAt` / `updatedAt` (DateTime): Ensures fair FIFO processing by ordering the queue.

## 5. The Concepts

### API Endpoint
- **What is it?** HTTP interfaces (`/api/upload`, `/api/job/[id]`, `/api/audit`) built in Next.js.
- **Why is it needed here?** To act as the secure boundary between the client UI and the database/worker backend.
- **How did I implement it?** Using Next.js App Router route handlers returning JSON responses.
- **What did I choose against, and why?** Chosen against calling the Gemini API directly from the client browser to protect the API key from public exposure and enforce server-side rate limiting.

### Official SDK vs Raw HTTP
- **What is it?** Using the `@google/genai` library instead of manual `fetch` calls to the Gemini REST API.
- **Why is it needed here?** To safely integrate with Gemini's advanced features like structured output schemas without manually managing complex JSON payloads.
- **How did I implement it?** Imported `GoogleGenAI` and utilized the `.generateContent()` method.
- **What did I choose against, and why?** Chosen against raw HTTP or third-party wrappers because the official SDK natively handles schema passing and typing, drastically reducing implementation bugs.

### System Prompts vs User Prompts
- **What is it?** System prompts dictate the fundamental behavior and persona of the AI, while user prompts provide the raw data to act upon.
- **Why is it needed here?** To enforce strict roles. The system allows one model (`gemini-3.6-flash`) to act as two entirely distinct agents (Extraction vs Auditor) based purely on system prompts.
- **How did I implement it?** Passed `systemInstruction` in the config block for the model, and passed the image/JSON as the `contents` array.
- **What did I choose against, and why?** Chosen against putting the instructions in the user prompt, as system instructions are significantly more resilient against prompt drift and hallucination.

### Model Parameters and Why
- **What is it?** Tuning values like temperature, tokens, and timeouts.
- **Why is it needed here?** To balance deterministic accuracy with analytical flexibility and protect against runaway generation.
- **How did I implement it?** Via `src/config.ts`. Extraction uses Temperature `0.1` and Max Tokens `1000`. Auditor uses Temperature `0.4` and Max Tokens `500`. Timeout is strictly set to `90,000 ms`.
- **What did I choose against, and why?** Chosen against default parameters (which typically use temperature 1.0) because expense extraction requires strict, near-zero hallucination formatting.

### Structured Output/Schema Validation
- **What is it?** Forcing the AI to return data mapping to a specific format, and then verifying it.
- **Why is it needed here?** Because the UI and database require predictable formats, not free-text prose.
- **How did I implement it?** 1. Gemini's `responseSchema` forces structured JSON generation natively. 2. We then independently validate the returned JSON using `zod` schemas.
- **What did I choose against, and why?** Chosen against parsing free-text markdown JSON blocks using Regex, as it is highly error-prone compared to native SDK schema enforcement.

### Validation Failure Handling
- **What is it?** Catching when the AI generates invalid or unparseable JSON.
- **Why is it needed here?** To prevent corrupted data from entering the database and breaking the UI.
- **How did I implement it?** By wrapping the `zod` `.parse()` step in a `try/catch`. *(Note: A deliberate validation-failure fixture `TEST_MODE_FORCE_VALIDATION_ERROR` exists in the worker to explicitly force a failure by injecting a string into a number field to honestly prove the retry loop works).*
- **What did I choose against, and why?** Chosen against trusting the AI blindly, because even models using strict structured output can occasionally hallucinate incorrect types.

### Background Jobs/Workers
- **What is it?** Processing heavy AI tasks in a separate background loop rather than blocking the HTTP request.
- **Why is it needed here?** AI extraction can take 15-90 seconds. Keeping an HTTP connection open that long causes timeouts and bad UX.
- **How did I implement it?** A standalone Node.js script (`worker.ts`) that polls the database for `pending` jobs.
- **What did I choose against, and why?** Chosen against blocking `await` calls in the `/api/upload` route, which would ruin server responsiveness.

### Queues/FIFO/Concurrency
- **What is it?** Managing the flow of jobs to ensure fairness and prevent overloading the system.
- **Why is it needed here?** To respect API rate limits and protect local memory.
- **How did I implement it?** Used `p-queue` with a strict `concurrency: 2`. Prisma `orderBy: { createdAt: "asc" }` enforces FIFO. We strictly use `retries: 3`.
- **What did I choose against, and why?** Chosen against processing all uploaded files simultaneously, which immediately triggers `429 Too Many Requests` API limits.

### Rate Limiting as Cost Control
- **What is it?** Blocking abusive amounts of requests from a single source.
- **Why is it needed here?** To protect the API key's billing quota from malicious spam loops.
- **How did I implement it?** A custom IP-based memory cache token bucket enforcing `5/min` on uploads and `10/min` on audits.
- **What did I choose against, and why?** Chosen against relying solely on Google's API limits, which could still drain thousands of requests before stopping.

### File Storage vs Database Storage
- **What is it?** How the uploaded receipts are persisted.
- **Why is it needed here?** To make the images available to the background worker.
- **How did I implement it?** Images are saved to the local `/uploads` folder. The database only stores a lightweight path string.
- **What did I choose against, and why?** Chosen against storing raw image `BLOB` or Base64 data directly in SQLite, as it drastically degrades database query performance.

### Cost Model
- **What is it?** An approximation of the financial cost of running the AI models.
- **Why is it needed here?** To understand the scaling economics of the application.
- **How did I implement it?** Evaluated against approximate standard Gemini Flash tier rates:
  - Extraction Run: ~400 input tokens + ~200 output tokens = ~$0.00009
  - Audit Run: ~150 input tokens + ~100 output tokens = ~$0.00004
  - Estimated Total: ~$0.00013 per receipt. *(Note: These are estimates based on standard Flash tiers, not guaranteed current pricing).*
- **What did I choose against, and why?** Chosen against ignoring costs, as AI features without cost models are dangerous in production SaaS environments.

## 6. What Went Wrong
1. **Symptom:** The background extraction jobs failed instantly with HTTP 503 "Service Unavailable" errors.
   **Investigation:** Checked the terminal worker logs (`raw_model_outputs.jsonl`) which explicitly captured the 503 errors from the `@google/genai` SDK on the models `gemini-3.8-flash` and `gemini-3.7-flash`.
   **Cause:** The specific Gemini model versions were experiencing temporary high-demand provider outages/capacity limits.
   **Fix:** Downgraded the model identifier configuration to the stable `gemini-3.6-flash`.

2. **Symptom:** The Policy Auditor request would fail repeatedly without returning an assessment.
   **Investigation:** Console logs revealed that the `Promise.race` timeout exception was being thrown, cancelling the AI request prematurely.
   **Cause:** The initial timeout was set too strictly to 15 seconds. Provider latency spikes during peak hours caused the Gemini API to take roughly 76 seconds to respond, meaning the application aborted the request before Gemini could finish.
   **Fix:** Increased the system timeout parameter from 15,000ms to 90,000ms to safely accommodate provider latency spikes while still guaranteeing an eventual fallback.

3. **Symptom:** The `gemini-3.6-flash` model began returning `429 Quota Exceeded` errors, and the worker immediately looped the retries, failing the job in 6 seconds.
   **Investigation:** Inspected the JSON evidence logs and found the exact error: `"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"`, with a strict limit of 20.
   **Cause:** The worker's immediate polling loop caused it to instantly retry 3 times against a rate limit block. Furthermore, the project's hard 20-request daily limit on the free tier had been completely exhausted.
   **Fix:** Implemented a 10-second exponential backoff delay in the worker thread before releasing the queue slot to improve retry resilience. However, because the limit exhausted was the strict daily (RPD) quota of 20, the jobs correctly and safely transitioned to a terminal `failed` state until the daily quota resets.

## 7. What This Slice Does Not Handle
- **Scale Limitations:** The local SQLite database and in-memory rate limiting map will not scale across multiple serverless edge functions or scaled Kubernetes pods.
- **Out of Scope:** User authentication and multi-tenant data isolation were out of scope for this slice. Anyone with access can view the jobs.
- **Storage Cleanup:** The system does not currently run cron jobs to purge the `/uploads` directory or old SQLite rows, meaning disk space will eventually fill up (omitted due to time constraints).
- **Time Limitations:** A fully unified dashboard showing historical data aggregation across all receipts was omitted due to time constraints, focusing purely on single-receipt extraction.

## 8. If I Built This Again
If I built this again, I would replace the local SQLite database and polling background worker with a managed serverless queue like AWS SQS or Vercel Inngest, paired with PostgreSQL. This change would completely eliminate the need for a local polling interval, ensure bulletproof horizontal scalability without file-locking issues, and provide native webhooks for job completion rather than forcing the frontend to constantly ping the server for status updates.
