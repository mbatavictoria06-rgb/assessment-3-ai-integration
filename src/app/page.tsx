"use client";

import { useState, useEffect, useRef } from "react";

const UploadIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="upload-icon">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="17 8 12 3 7 8"></polyline>
    <line x1="12" y1="3" x2="12" y2="15"></line>
  </svg>
);

const Spinner = () => (
  <svg className="spinner" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="2" x2="12" y2="6"></line>
    <line x1="12" y1="18" x2="12" y2="22"></line>
    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
    <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
    <line x1="2" y1="12" x2="6" y2="12"></line>
    <line x1="18" y1="12" x2="22" y2="12"></line>
    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
    <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
  </svg>
);

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [resultData, setResultData] = useState<any>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const [isAuditing, setIsAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState<any>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  const pollingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setUploadError(null);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setIsUploading(true);
    setUploadError(null);
    setJobId(null);
    setJobStatus(null);
    setResultData(null);
    setJobError(null);
    setAuditResult(null);
    setAuditError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Upload failed");
      }

      setJobId(data.jobId);
      setJobStatus(data.status);
    } catch (err: any) {
      setUploadError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  useEffect(() => {
    if (!jobId || jobStatus === "done" || jobStatus === "failed") {
      if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/job/${jobId}`);
        const data = await res.json();
        
        if (res.ok) {
          setJobStatus(data.status);
          if (data.status === "done") {
            setResultData(JSON.parse(data.resultData));
          } else if (data.status === "failed") {
            setJobError(data.errorMessage || "Processing failed");
          }
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    };

    pollingTimerRef.current = setInterval(poll, 3000);

    return () => {
      if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
    };
  }, [jobId, jobStatus]);

  const handleAudit = async () => {
    if (!jobId) return;
    setIsAuditing(true);
    setAuditError(null);

    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Audit failed");
      }

      setAuditResult(data.audit);
    } catch (err: any) {
      setAuditError(err.message);
    } finally {
      setIsAuditing(false);
    }
  };

  const isWorking = isUploading || jobStatus === "pending" || jobStatus === "processing";

  return (
    <div className="dashboard-wrapper">
      <header className="dashboard-header">
        <h1>Expense Processing Engine</h1>
        <p className="subtitle">AI-powered receipt extraction and compliance auditing.</p>
      </header>
      
      <main className="dashboard-grid">
        {/* Upload Column */}
        <section className="card upload-card">
          <h2>1. Submit Receipt</h2>
          
          <div className={`upload-zone ${file ? 'has-file' : ''}`}>
            <UploadIcon />
            <p className="upload-prompt">
              {file ? file.name : "Select Receipt Image"}
            </p>
            <p className="upload-constraints">JPG or PNG (Max 5MB)</p>
            <input 
              type="file" 
              className="file-input" 
              onChange={handleFileChange}
              accept="image/jpeg, image/png"
              disabled={isWorking}
            />
          </div>
          
          <button 
            className="btn btn-primary btn-block"
            onClick={handleUpload} 
            disabled={!file || isWorking}
          >
            {isUploading ? (
              <><Spinner /> Uploading...</>
            ) : (
              "Process Receipt"
            )}
          </button>

          {uploadError && <div className="alert alert-error">{uploadError}</div>}

          {jobId && (
            <div className="status-panel">
              <div className="status-header">
                <h3>Processing Status</h3>
                <span className={`badge badge-${jobStatus || "unknown"}`}>
                  {jobStatus === "processing" && <Spinner />}
                  {jobStatus}
                </span>
              </div>
              
              {jobStatus === "pending" && <p className="status-text">Job queued. Waiting for background worker capacity...</p>}
              {jobStatus === "processing" && <p className="status-text">AI is actively analyzing the image...</p>}
              {jobStatus === "done" && <p className="status-text success">Extraction complete!</p>}
              
              <div className="job-id-text">Job ID: {jobId}</div>

              {jobError && (
                <div className="alert alert-error mt-4">
                  <strong>Extraction Failed:</strong> {jobError}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Results Column */}
        <section className="card results-card">
          <h2>2. Extracted Data</h2>
          
          {!resultData && !isWorking && (
            <div className="empty-state">
              <p>Upload a receipt to see extraction results here.</p>
            </div>
          )}

          {isWorking && !resultData && (
            <div className="empty-state processing-state">
              <Spinner />
              <p>Awaiting results...</p>
            </div>
          )}

          {jobStatus === "done" && resultData && (
            <div className="receipt-view">
              <div className="receipt-header">
                <h3>{resultData.merchant || "Unknown Merchant"}</h3>
                <div className="receipt-date">{resultData.date ? new Date(resultData.date).toLocaleDateString() : "No date"}</div>
              </div>

              <div className="receipt-total">
                <span className="currency">{resultData.currency || ""}</span>
                <span className="amount">{resultData.total_amount ? resultData.total_amount.toFixed(2) : "0.00"}</span>
              </div>

              <div className="receipt-meta">
                <div className="meta-item">
                  <span className="meta-label">Category:</span>
                  <span className="meta-value">{resultData.category || "N/A"}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Payment:</span>
                  <span className="meta-value">{resultData.payment_method || "N/A"}</span>
                </div>
              </div>

              {resultData.items && resultData.items.length > 0 && (
                <div className="receipt-items">
                  <h4>Line Items</h4>
                  <table>
                    <tbody>
                      {resultData.items.map((item: any, idx: number) => (
                        <tr key={idx}>
                          <td className="item-desc">{item.description || "Unknown item"}</td>
                          <td className="item-price">{item.price ? item.price.toFixed(2) : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="audit-action">
                <button 
                  className="btn btn-secondary btn-block" 
                  onClick={handleAudit}
                  disabled={isAuditing}
                >
                  {isAuditing ? (
                    <><Spinner /> Running Policy Audit...</>
                  ) : (
                    "Run Policy Auditor"
                  )}
                </button>
              </div>

              {auditError && (
                <div className="alert alert-error mt-4">
                  <strong>Audit Failed:</strong> {auditError}
                </div>
              )}

              {auditResult && (
                <div className="audit-report">
                  <div className="audit-report-header">
                    <h3>Policy Audit Report</h3>
                    <span className={`risk-badge risk-${auditResult.risk_level?.toLowerCase()}`}>
                      Risk: {auditResult.risk_level?.toUpperCase()}
                    </span>
                  </div>
                  
                  <div className="audit-report-body">
                    <p className="anomalies-text">
                      <strong>Anomalies Detected:</strong> {auditResult.anomalies_detected ? "Yes" : "No"}
                    </p>
                    
                    <div className="audit-notes">
                      <strong>Assessment:</strong>
                      <p>{auditResult.auditor_notes || "No notes provided."}</p>
                    </div>

                    {auditResult.flags && auditResult.flags.length > 0 && (
                      <div className="audit-flags">
                        <strong>Policy Flags:</strong>
                        <div className="chips-container">
                          {auditResult.flags.map((flag: string, idx: number) => (
                            <span key={idx} className="chip">{flag}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
