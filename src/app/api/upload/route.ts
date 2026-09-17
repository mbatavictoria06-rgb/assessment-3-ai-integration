import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { config } from "../../../config";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const prisma = new PrismaClient();

// In-memory rate limiting (IP-based)
const rateLimitCache = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitCache.get(ip);
  
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitCache.set(ip, { count: 1, windowStart: now });
    return true;
  }
  
  if (record.count >= config.RATE_LIMIT_PROCESSING_TRIGGER) {
    return false;
  }
  
  record.count++;
  return true;
}

export async function POST(req: NextRequest) {
  try {
    // Basic rate limit by IP (fallback to generic if IP missing)
    const ip = req.headers.get("x-forwarded-for") || "unknown-ip";
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    // Validation
    if (file.size > config.MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: "File exceeds maximum size allowed." }, { status: 400 });
    }

    if (!config.ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json({ error: "Unsupported file type." }, { status: 400 });
    }

    // Save File
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const uploadsDir = path.join(process.cwd(), "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    
    // Generate unique filename to avoid collisions
    const fileExt = path.extname(file.name) || (file.type === "application/pdf" ? ".pdf" : ".jpg");
    const uniqueFilename = `${crypto.randomUUID()}${fileExt}`;
    const filePath = path.join(uploadsDir, uniqueFilename);
    
    await fs.writeFile(filePath, buffer);

    // Create Job
    const job = await prisma.job.create({
      data: {
        fileReference: `uploads/${uniqueFilename}`,
        status: "pending",
      },
    });

    return NextResponse.json({ jobId: job.id, status: job.status }, { status: 201 });

  } catch (error) {
    console.error("[Upload API] Error processing upload:", error);
    return NextResponse.json(
      { error: "An internal server error occurred while processing the upload." },
      { status: 500 }
    );
  }
}
