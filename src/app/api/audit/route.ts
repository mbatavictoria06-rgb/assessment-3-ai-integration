import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { config } from "../../../config";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

const prisma = new PrismaClient();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const AuditSchema = z.object({
  anomalies_detected: z.boolean(),
  flags: z.array(z.string()),
  risk_level: z.string().describe("low, medium, high"),
  auditor_notes: z.string()
});

// In-memory rate limiting for Follow-up (IP-based)
const rateLimitCache = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitCache.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitCache.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= config.RATE_LIMIT_FOLLOW_UP) {
    return false;
  }
  record.count++;
  return true;
}

async function logEvidence(jobId: string, rawOutput: any, parsedResult: any, success: boolean) {
  try {
    const evidenceDir = path.join(process.cwd(), "evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    const logEntry = { timestamp: new Date().toISOString(), type: "AUDIT", jobId, success, rawOutput, parsedResult };
    await fs.appendFile(path.join(evidenceDir, "raw_model_outputs.jsonl"), JSON.stringify(logEntry) + "\n");
  } catch (err) {
    console.error(`[Audit API] Failed to write evidence log:`, err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown-ip";
    if (!checkRateLimit(ip)) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const { jobId } = await req.json();
    if (!jobId) {
      return NextResponse.json({ error: "Job ID is required" }, { status: 400 });
    }

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.status !== "done" || !job.resultData) {
      return NextResponse.json({ error: "Job has not completed extraction successfully" }, { status: 400 });
    }

    // AI Retry Loop
    let attempts = 0;
    let lastError = null;

    while (attempts < config.MAX_ATTEMPTS) {
      try {
        attempts++;
        const geminiAuditSchema = {
          type: "object",
          properties: {
            anomalies_detected: { type: "boolean" },
            flags: { type: "array", items: { type: "string" } },
            risk_level: { type: "string", description: "low, medium, high" },
            auditor_notes: { type: "string" }
          },
          required: ["anomalies_detected", "flags", "risk_level", "auditor_notes"]
        };

        const response = await Promise.race([
          ai.models.generateContent({
            model: config.AUDITOR_MODEL_ID,
            contents: job.resultData, // Send the validated structured extraction directly
            config: {
              systemInstruction: "You are a corporate expense auditor. Review the following structured receipt data. Identify any anomalies, unusually high prices for the category, or potential policy violations (e.g., alcohol, weekend purchases). Provide a short, strict assessment.",
              temperature: config.FOLLOW_UP_TEMPERATURE,
              maxOutputTokens: config.FOLLOW_UP_MAX_TOKENS,
              responseMimeType: "application/json",
              responseSchema: geminiAuditSchema,
            }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("AI Request Timeout")), config.AUDITOR_TIMEOUT_MS))
        ]) as any;

        const rawAiResponse = response.text;
        
        if (!rawAiResponse) {
          throw new Error("Empty response from AI");
        }

        const parsedData = AuditSchema.parse(JSON.parse(rawAiResponse));
        
        await logEvidence(jobId, rawAiResponse, parsedData, true);

        return NextResponse.json({ audit: parsedData });
      } catch (err: any) {
        console.error(`[Audit API] Attempt ${attempts} failed:`, err.message);
        lastError = err;
        if (attempts >= config.MAX_ATTEMPTS) {
          await logEvidence(jobId, err.message, null, false);
        } else {
          // simple backoff
          await new Promise(res => setTimeout(res, 1000 * attempts));
        }
      }
    }

    return NextResponse.json(
      { error: "Audit failed after multiple attempts.", details: lastError?.message },
      { status: 502 }
    );

  } catch (error: any) {
    console.error("[Audit API] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
