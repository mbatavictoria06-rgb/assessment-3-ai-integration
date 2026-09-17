import { PrismaClient } from "@prisma/client";
import PQueue from "p-queue";
import { config } from "./config";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import path from "path";

const prisma = new PrismaClient();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Ensure strict concurrency according to configuration
const queue = new PQueue({ concurrency: config.MAX_CONCURRENCY });

let isShuttingDown = false;
let pollingTimer: NodeJS.Timeout | null = null;

// The strict Zod schema for structured output extraction
const ReceiptSchema = z.object({
  merchant: z.string(),
  date: z.string().describe("ISO 8601 format"),
  total_amount: z.number(),
  currency: z.string().describe("3 letter currency code, e.g. USD"),
  items: z.array(z.object({
    description: z.string(),
    price: z.number()
  })),
  category: z.string(),
  payment_method: z.string().optional(),
  short_summary: z.string()
});

async function logEvidence(jobId: string, rawOutput: any, parsedResult: any, success: boolean) {
  try {
    const evidenceDir = path.join(process.cwd(), "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      jobId,
      success,
      rawOutput,
      parsedResult,
    };
    
    await fs.appendFile(
      path.join(evidenceDir, "raw_model_outputs.jsonl"),
      JSON.stringify(logEntry) + "\n"
    );
  } catch (err) {
    console.error(`[Worker] Failed to write evidence log for job ${jobId}:`, err);
  }
}

async function processJob(jobId: string) {
  let job;
  try {
    job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;

    console.log(`[Worker] Started processing job ${jobId} (Attempt ${job.attempts + 1})`);

    let parsedData: any = null;
    let rawAiResponse: any = null;

    try {
      const filePath = path.join(process.cwd(), job.fileReference);
      const fileBuffer = await fs.readFile(filePath);
      const base64Image = fileBuffer.toString("base64");
      
      let mimeType = "image/jpeg";
      if (job.fileReference.endsWith(".png")) mimeType = "image/png";

      // VALIDATION-FAILURE FIXTURE
      if (process.env.TEST_MODE_FORCE_VALIDATION_ERROR === "true" || job.fileReference.includes("FAIL_VALIDATION")) {
        console.log(`[Worker] TEST FIXTURE: Injecting validation error for job ${jobId}`);
        rawAiResponse = JSON.stringify({
           merchant: "Test Merchant",
           date: "2024-01-01",
           total_amount: "THIS_SHOULD_BE_A_NUMBER_TO_FAIL_ZOD",
           currency: "USD",
           items: [],
           category: "Test",
           short_summary: "Test"
        });
      } else {
        const geminiSchema = {
          type: "object",
          properties: {
            merchant: { type: "string" },
            date: { type: "string", description: "ISO 8601 format" },
            total_amount: { type: "number" },
            currency: { type: "string", description: "3 letter currency code, e.g. USD" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  price: { type: "number" }
                },
                required: ["description", "price"]
              }
            },
            category: { type: "string" },
            payment_method: { type: "string" },
            short_summary: { type: "string" }
          },
          required: ["merchant", "date", "total_amount", "currency", "items", "category", "short_summary"]
        };

        const response = await Promise.race([
          ai.models.generateContent({
            model: config.GEMINI_MODEL_ID,
            contents: [
              "Extract the data from this receipt.",
              { inlineData: { data: base64Image, mimeType: mimeType } }
            ],
            config: {
              systemInstruction: "You are a precise data extraction assistant. Analyze the provided receipt image. Extract the merchant name, date, total amount, currency, purchased items, general category, and payment method. If a field is illegible, output null. Do not invent information. For total_amount and item price, output only raw numeric values without currency symbols or quotation marks. For example, use 44.04, not \"$44.04\" or \"44.04\". Return JSON matching this exact schema: " + JSON.stringify(geminiSchema),
              temperature: config.EXTRACTION_TEMPERATURE,
              maxOutputTokens: config.EXTRACTION_MAX_TOKENS,
              responseMimeType: "application/json",
            }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("AI Request Timeout")), config.GEMINI_TIMEOUT_MS))
        ]) as any;

        rawAiResponse = response.text;
      }
      
      // Validate the JSON explicitly with Zod before saving
      if (rawAiResponse) {
        parsedData = ReceiptSchema.parse(JSON.parse(rawAiResponse));
      } else {
        throw new Error("AI returned empty response");
      }

      // 1. Log the concrete evidence of the raw and validated model outputs
      await logEvidence(jobId, rawAiResponse, parsedData, true);

      // 2. Mark job as done and save the resultData
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "done",
          resultData: JSON.stringify(parsedData),
          attempts: job.attempts + 1,
        }
      });
      console.log(`[Worker] Successfully completed job ${jobId}`);
      
    } catch (aiError: any) {
      await logEvidence(jobId, rawAiResponse || aiError.message, null, false);
      throw aiError; // Throw so outer block can handle retry logic
    }

  } catch (error: any) {
    console.error(`[Worker] Error processing job ${jobId}:`, error.message);
    
    if (job) {
      const newAttempts = job.attempts + 1;
      const isFatal = newAttempts >= config.MAX_ATTEMPTS;

      // If we are going to retry, apply a backoff delay BEFORE setting it to pending
      // This prevents the polling loop from instantly picking it back up and breaching rate limits
      if (!isFatal) {
        console.log(`[Worker] Job ${jobId} failed. Applying 10-second backoff delay before retry...`);
        await new Promise(res => setTimeout(res, 10000));
      }

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: isFatal ? "failed" : "pending",
          attempts: newAttempts,
          errorMessage: isFatal ? `Processing failed: ${error.message}` : null,
        }
      });
      
      if (isFatal) {
        console.log(`[Worker] Job ${jobId} failed permanently after ${newAttempts} attempts.`);
      } else {
        console.log(`[Worker] Job ${jobId} scheduled for retry and released to queue.`);
      }
    }
  }
}

async function pollJobs() {
  if (isShuttingDown) return;

  try {
    const availableCapacity = config.MAX_CONCURRENCY - queue.pending;
    
    if (availableCapacity > 0) {
      // Find pending jobs older than RETRY_BACKOFF_DELAY_MS (if it's a retry)
      // For simplicity, we just fetch any pending jobs in order.
      const jobs = await prisma.job.findMany({
        where: { status: "pending" },
        take: availableCapacity,
        orderBy: { createdAt: "asc" },
      });

      for (const job of jobs) {
        // Optimistically mark as processing
        await prisma.job.update({
          where: { id: job.id },
          data: { status: "processing" },
        });

        // Enqueue the job for processing
        queue.add(() => processJob(job.id));
      }
    }
  } catch (error) {
    console.error("[Worker] Error polling jobs:", error);
  } finally {
    if (!isShuttingDown) {
      pollingTimer = setTimeout(pollJobs, config.WORKER_POLLING_INTERVAL_MS);
    }
  }
}

async function shutdown() {
  console.log("\n[Worker] Graceful shutdown initiated...");
  isShuttingDown = true;
  
  if (pollingTimer) clearTimeout(pollingTimer);
  console.log("[Worker] Waiting for active jobs to finish...");
  await queue.onIdle();
  console.log("[Worker] Disconnecting database...");
  await prisma.$disconnect();
  console.log("[Worker] Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function start() {
  console.log(`[Worker] Starting background worker (Extraction Engine)`);
  console.log(`[Worker] Concurrency: ${config.MAX_CONCURRENCY}, Timeout: ${config.GEMINI_TIMEOUT_MS}ms, Retries: ${config.MAX_ATTEMPTS}`);
  
  try {
    await prisma.$connect();
    console.log("[Worker] Successfully connected to Prisma.");
  } catch (error) {
    console.error("[Worker] Failed to connect to database:", error);
    process.exit(1);
  }

  pollJobs();
}

start();
