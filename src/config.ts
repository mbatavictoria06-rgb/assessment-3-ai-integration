export const config = {
  // Models & AI
  GEMINI_MODEL_ID: "gemini-1.5-flash",
  AUDITOR_MODEL_ID: "gemini-1.5-flash",
  EXTRACTION_TEMPERATURE: 0.1, // Low for factual extraction
  FOLLOW_UP_TEMPERATURE: 0.4, // Slightly higher for analysis
  EXTRACTION_MAX_TOKENS: 4096,
  FOLLOW_UP_MAX_TOKENS: 500,
  GEMINI_TIMEOUT_MS: 90000,
  AUDITOR_TIMEOUT_MS: 90000,
  
  // Worker & Queue
  MAX_CONCURRENCY: 2,
  WORKER_POLLING_INTERVAL_MS: 2000,
  MAX_ATTEMPTS: 3,
  RETRY_BACKOFF_DELAY_MS: 5000,
  
  // Limits
  MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024, // 5MB
  MAX_FILES_PER_UPLOAD: 5,
  ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png'],
  
  // UI
  UI_POLLING_INTERVAL_MS: 3000,
  
  // Rate Limiting (In-memory simple rate limiters)
  RATE_LIMIT_PROCESSING_TRIGGER: 5, // per minute per IP
  RATE_LIMIT_FOLLOW_UP: 10, // per minute per IP
};
