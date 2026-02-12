'use client';

import React, { useState, useEffect, useRef } from 'react';
import { sanitizeFilename, formatDuration, formatTimestamp } from '@/lib/file-utils';
import { processAudioFile, AudioChunk } from '@/lib/audio-processing';
import { quotaManager } from '@/lib/quota-manager'; // Client-side usage? define types
import { generateDocx } from '@/lib/docx-generator';
import { Upload, FileAudio, Play, Pause, Download, AlertTriangle, CheckCircle, Loader2, Clock, Eye, Copy, Check } from 'lucide-react';
// import { saveAs } from 'file-saver'; // Removed unused dependency
// actually I can use raw anchor tag for download

// --- TYPES ---

type ProcessingStatus = 'idle' | 'chunking' | 'ready_to_transcribe' | 'transcribing' | 'paused' | 'completed' | 'error';

interface ChunkStatus {
  id: number;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'skipped';
  modelUsed?: string;
  transcript?: string;
  segments?: any[];
  errorMsg?: string;
}

interface AppState {
  file: File | null;
  originalFilename: string;
  chunks: AudioChunk[]; // Not persisted in localStorage
  chunkStatuses: ChunkStatus[];
  currentChunkIndex: number;
  status: ProcessingStatus;
  quotaLogs: string[];
}

// --- COMPONENT ---

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [chunks, setChunks] = useState<AudioChunk[]>([]);
  const [chunkStatuses, setChunkStatuses] = useState<ChunkStatus[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [apiLog, setApiLog] = useState<string[]>([]);
  const [quotaInfo, setQuotaInfo] = useState({
    v3: { hourly: 7200, daily: 28800 },
    turbo: { hourly: 7200, daily: 28800 }
  });

  // Manual Flow State
  const [contextDescription, setContextDescription] = useState("A spiritual discourse in Bengali with Sanskrit slokas.");
  const [glossary, setGlossary] = useState("Krishna, Bhagavatam, Prabhavishnu");
  const [styleGuide, setStyleGuide] = useState("ওঁ নমো ভগবতে বাসুদেবায় । যদা যদা হি ধর্মস্য গ্লানির্ভবতি ভারত ।"); // Sanskrit in Bengali script
  const [isSaving, setIsSaving] = useState(false);

  // Helper to construct prompt
  const constructPrompt = (prevTranscript: string = "") => {
    // Limit to ~224 tokens. 
    // Priority: Style Guide (Crucial for script) > Context > Glossary > Prev Text
    // Style guide ~ 15-20 tokens. Context ~ 10-15. Glossary ~ 10. 
    // We have plenty of room for prev text.

    const base = `${contextDescription} Write Sanskrit in Bengali script like: ${styleGuide} Key terms: ${glossary}.`;
    const remainingChars = 900 - base.length; // Approximate char limit for 224 tokens

    let context = "";
    if (prevTranscript && remainingChars > 50) {
      // Take last N chars
      context = ` Previous text: ${prevTranscript.slice(-remainingChars)}`;
    }

    return base + context;
  };

  const handleSaveChunks = async () => {
    setIsSaving(true);
    setProgressMsg("Saving chunks to local server...");

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const formData = new FormData();
        formData.append("file", chunk.blob);
        formData.append("filename", file?.name || "audio");
        formData.append("chunkIndex", i.toString());

        const res = await fetch("/api/save-chunk", { method: "POST", body: formData });
        if (!res.ok) throw new Error(`Failed to save chunk ${i}`);
      }
      setApiLog(prev => [...prev, "All chunks saved locally."]);
      setStatus("ready_to_transcribe"); // Move to manual phase
    } catch (e: any) {
      console.error(e);
      setApiLog(prev => [...prev, `Save Error: ${e.message}`]);
    } finally {
      setIsSaving(false);
    }
  };

  const transcribeSingleChunk = async (index: number) => {
    const chunk = chunks[index];
    // Get previous transcript for context if available
    const prevChunk = chunkStatuses[index - 1];
    const prevText = (prevChunk && prevChunk.status === 'completed' && prevChunk.transcript)
      ? prevChunk.transcript
      : "";

    // Helper to update status safely
    const updateStatus = (status: ChunkStatus['status'], data: Partial<ChunkStatus> = {}) => {
      setChunkStatuses(prev => {
        const next = [...prev];
        next[index] = { ...next[index], status, ...data };
        return next;
      });
    };

    const prompt = constructPrompt(prevText);
    const duration = chunk.duration;

    // Check quota locally first (kept for legacy/consistency, even if using GCP)
    let model = quotaManager.getPreferredModel(duration);

    updateStatus('processing', { modelUsed: 'google-chirp-batch' });
    setProgressMsg(`Uploading Chunk ${index + 1}...`);

    try {
      const formData = new FormData();
      formData.append('file', chunk.blob, `chunk_${index}.mp3`);
      formData.append('model', model || 'whisper-large-v3'); // Fallback
      formData.append('prompt', prompt);
      formData.append('language', 'bn');

      setApiLog(prev => [...prev, `[Chunk ${index + 1}] Uploading to Google Cloud...`]);

      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Transcription failed");
      }

      // Google Cloud Flow: We get an operationName
      const { operationName } = data;
      setProgressMsg("Processing with Google Cloud (Dynamic Batch)... This saves 75% cost but may take a moment.");

      // Poll for status
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/status?operationName=${operationName}`);
          const statusData = await statusRes.json();

          if (statusData.status === 'completed') {
            clearInterval(pollInterval);

            let text = "";

            // The server now decodes the transcript for us
            if (statusData.transcript) {
              text = statusData.transcript;
            }
            // Fallback: try parsing raw response if server couldn't decode
            else if (statusData.raw && statusData.raw.response && statusData.raw.response.results) {
              Object.values(statusData.raw.response.results).forEach((fileResult: any) => {
                if (fileResult?.transcript?.results) {
                  fileResult.transcript.results.forEach((r: any) => {
                    if (r.alternatives && r.alternatives[0]) {
                      text += r.alternatives[0].transcript + " ";
                    }
                  });
                }
              });
            }

            if (!text) text = "[Error: Could not parse transcript from Google response]";

            updateStatus('completed', {
              transcript: text.trim(),
              modelUsed: 'google-chirp-batch'
            });
            setProgressMsg("");
          } else if (statusData.status === 'error') {
            clearInterval(pollInterval);
            throw new Error(statusData.error);
          } else {
            // still processing
            setProgressMsg(`Processing with Google Cloud... ${Math.round(statusData.progress || 0)}%`);
          }
        } catch (e) {
          console.error("Polling error", e);
        }
      }, 5000); // Poll every 5s

    } catch (error: any) {
      console.error(error);
      updateStatus('error', { errorMsg: error.message });
      setProgressMsg("");
    }
  };


  const updateQuotaDisplay = () => {
    // quotaManager is client-side singleton
    const v3 = quotaManager.getRemaining('whisper-large-v3');
    const turbo = quotaManager.getRemaining('whisper-large-v3-turbo');
    setQuotaInfo({
      v3: { hourly: v3.hourly, daily: v3.daily },
      turbo: { hourly: turbo.hourly, daily: turbo.daily }
    });
  };

  useEffect(() => {
    // Initial quota check
    updateQuotaDisplay();
    const interval = setInterval(updateQuotaDisplay, 30000); // Poll every 30s
    return () => clearInterval(interval);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setFile(selected);
      setStatus('idle');
      setChunks([]);
      setChunkStatuses([]);
      setApiLog([]);
      // Reset statuses
    }
  };

  const startChunking = async () => {
    if (!file) return;
    setStatus('chunking');
    setProgress(0);
    setProgressMsg("Initializing ffmpeg...");

    try {
      const generatedChunks = await processAudioFile(file, (p, msg) => {
        setProgress(p * 100);
        setProgressMsg(msg);
      });

      setChunks(generatedChunks);

      // Initialize statuses
      // Check if we have existing progress for this file?
      // Simplification: We blindly overwrite for now, unless we match hash.
      // But user wanted resume.
      // Let's check localStorage for "last_job_filename"
      const lastFile = localStorage.getItem('last_job_filename');
      const lastStatusesStr = localStorage.getItem('last_job_statuses');

      let verifiedStatuses: ChunkStatus[] = generatedChunks.map(c => ({
        id: c.index,
        status: 'pending'
      }));

      if (lastFile === file.name && lastStatusesStr) {
        try {
          const savedStatuses: ChunkStatus[] = JSON.parse(lastStatusesStr);
          // Merge: allow resume of completed ones
          if (savedStatuses.length === generatedChunks.length) {
            alert("Found previous progress for this file. Resuming...");
            verifiedStatuses = savedStatuses.map((s, i) => {
              if (s.status === 'processing') return { ...s, status: 'pending' };
              return s;
            });
          }
        } catch (e) { console.error(e) }
      }

      setChunkStatuses(verifiedStatuses);
      setStatus('ready_to_transcribe');
      localStorage.setItem('last_job_filename', file.name);

    } catch (e: any) {
      console.error(e);
      setStatus('error');
      setApiLog(prev => [...prev, `Chunking Error: ${e.message}`]);
    }
  };

  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasCompletedChunks = chunkStatuses.some(s => s.status === 'completed' && s.transcript);

  const getFullTranscript = () => {
    return chunkStatuses
      .filter(s => s.status === 'completed' && s.transcript)
      .sort((a, b) => a.id - b.id)
      .map(s => s.transcript)
      .join('\n\n');
  };

  const copyToClipboard = async () => {
    const text = getFullTranscript();
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadDocx = async () => {
    // Filter completed — handle both segment-based (Groq) and transcript-only (Google Cloud) results
    const completed = chunkStatuses
      .filter(s => s.status === 'completed' && (s.segments || s.transcript))
      .map(s => ({
        chunkIndex: s.id,
        startTimeOffset: chunks[s.id]?.startTime || 0,
        segments: s.segments,
        transcript: s.transcript
      }));

    if (completed.length === 0) return;

    // Map segments — use transcript as fallback if no segments (Google Cloud flow)
    const mapped = completed.map(c => ({
      chunkIndex: c.chunkIndex,
      startTimeOffset: c.startTimeOffset,
      segments: c.segments || [{ start: 0, end: 0, text: c.transcript || '' }]
    }));

    const blob = await generateDocx(file?.name || 'transcript', mapped);
    const safeName = sanitizeFilename(file?.name || 'transcript') + '.docx';

    // Use classic download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-neutral-900 text-neutral-100 p-8 font-sans">
      <div className="max-w-5xl mx-auto space-y-8">
        <header className="flex justify-between items-center border-b border-neutral-800 pb-6">
          <h1 className="text-2xl font-bold tracking-tight text-emerald-400">Bengali Audio Transcriber <span className="text-neutral-500 text-sm font-normal ml-2">v2.0 Manual Control</span></h1>
          <div className="text-xs text-neutral-500 font-mono flex gap-4">
            <div className="flex flex-col items-end gap-1">
              <div className="text-right">
                <span className="text-neutral-400 font-bold block text-xs">Whisper Large V3</span>
                <span className={`text-xs font-mono ${quotaInfo.v3.hourly < 600 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {formatDuration(quotaInfo.v3.hourly)} left / 2h
                </span>
              </div>
              <div className="text-right">
                <span className="text-neutral-400 font-bold block text-xs">Turbo</span>
                <span className={`text-xs font-mono ${quotaInfo.turbo.hourly < 600 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {formatDuration(quotaInfo.turbo.hourly)} left / 2h
                </span>
              </div>
            </div>
          </div>
        </header>

        {/* Prompt Settings */}
        <section className="bg-neutral-800/30 p-6 rounded-xl border border-neutral-700 space-y-4">
          <h2 className="text-sm font-bold text-neutral-400 uppercase tracking-wider">Transcription Context</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Context Description (Nature of Talk)</label>
              <textarea
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-3 text-sm focus:border-emerald-500 focus:outline-none"
                rows={2}
                value={contextDescription}
                onChange={(e) => setContextDescription(e.target.value)}
                placeholder="E.g., A spiritual discourse in Bengali about material suffering..."
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Glossary (Comma separated names/terms)</label>
              <textarea
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-3 text-sm focus:border-emerald-500 focus:outline-none"
                rows={2}
                value={glossary}
                onChange={(e) => setGlossary(e.target.value)}
                placeholder="Krishna, Bhagavatam, Chaitanya..."
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-neutral-500 mb-1">Style Guide (Sanskrit Slokas in Bengali Script)</label>
              <textarea
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-3 text-sm focus:border-emerald-500 focus:outline-none font-bengali"
                rows={2}
                value={styleGuide}
                onChange={(e) => setStyleGuide(e.target.value)}
                placeholder="Put a sample sloka here explicitly in Bengali script to guide the model."
              />
              <p className="text-[10px] text-neutral-500 mt-1">
                *Crucial*: This teaches the model to write Sanskrit sounds using Bengali letters (e.g. "নমো" instead of "namo").
              </p>
            </div>
          </div>
        </section>

        {/* Upload Section */}
        <section className="space-y-4">
          {status === 'idle' && (
            <div className="border-2 border-dashed border-neutral-700 rounded-xl p-10 flex flex-col items-center justify-center transition hover:border-emerald-500/50 hover:bg-neutral-800/50">
              <input
                type="file"
                accept="audio/*"
                onChange={handleFileSelect}
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center">
                <Upload className="w-10 h-10 text-neutral-400 mb-4" />
                <span className="text-lg font-medium text-neutral-300">
                  {file ? file.name : "Select Audio File"}
                </span>
                <span className="text-sm text-neutral-500 mt-2">MP3, M4A, WAV (Max 2GB local)</span>
              </label>
            </div>
          )}

          {((status === 'idle' && file)) && (
            <div className="flex justify-center">
              <button
                onClick={startChunking}
                className="bg-emerald-600 hover:bg-emerald-500 text-white px-8 py-3 rounded-full font-medium transition flex items-center gap-2"
              >
                <FileAudio /> Prepare Chunks
              </button>
            </div>
          )}

          {status === 'chunking' && (
            <div className="space-y-2">
              <div className="w-full bg-neutral-800 rounded-full h-2 overflow-hidden">
                <div className="bg-emerald-500 h-full transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
              <div className="text-center text-sm text-neutral-400">{progressMsg}</div>
            </div>
          )}
        </section>

        {/* Manual Dashboard */}
        {chunks.length > 0 && status !== 'chunking' && (
          <section className="bg-neutral-800/50 rounded-xl p-6 space-y-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <CheckCircle className="text-emerald-500 w-5 h-5" />
                {chunks.length} Chunks Ready
              </h2>
              <div className="flex gap-2">
                {hasCompletedChunks && (
                  <>
                    <button
                      onClick={() => setShowPreview(!showPreview)}
                      className="bg-neutral-700 text-white hover:bg-neutral-600 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
                    >
                      <Eye className="w-4 h-4" /> {showPreview ? 'Hide' : 'Preview'}
                    </button>
                    <button
                      onClick={copyToClipboard}
                      className="bg-neutral-700 text-white hover:bg-neutral-600 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
                    >
                      {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      onClick={downloadDocx}
                      className="bg-emerald-600 text-white hover:bg-emerald-500 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
                    >
                      <Download className="w-4 h-4" /> Export DOCX
                    </button>
                  </>
                )}
                {status !== 'ready_to_transcribe' && !hasCompletedChunks && (
                  <button
                    onClick={handleSaveChunks}
                    disabled={isSaving}
                    className="bg-blue-600 text-white hover:bg-blue-500 px-6 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
                  >
                    {isSaving ? <Loader2 className="animate-spin w-4 h-4" /> : <Download className="w-4 h-4" />}
                    Save Chunks Locally First
                  </button>
                )}
              </div>
            </div>

            <div className="grid gap-4">
              {chunkStatuses.map((s, idx) => (
                <div key={idx} className={`p-4 rounded-lg border flex flex-col md:flex-row gap-4 items-start md:items-center justify-between ${s.status === 'completed' ? 'border-emerald-900/50 bg-emerald-900/10' : 'border-neutral-700 bg-neutral-800'
                  }`}>
                  <div className="flex items-center gap-4 min-w-[200px]">
                    <div className="w-8 h-8 rounded-full bg-neutral-700 flex items-center justify-center font-mono text-xs text-neutral-400">
                      {idx + 1}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-neutral-200">
                        {formatTimestamp(chunks[idx].startTime)} - {formatTimestamp(chunks[idx].endTime)}
                      </div>
                      <div className="text-xs text-neutral-500">
                        {formatDuration(chunks[idx].duration)} • {(chunks[idx].blob.size / 1024 / 1024).toFixed(2)}MB
                      </div>
                    </div>
                  </div>

                  {/* Transcript Preview or Status */}
                  <div className="flex-1 text-sm text-neutral-400 font-mono overflow-hidden">
                    {s.status === 'completed' ? (
                      <div className="line-clamp-2 text-neutral-300 italic">" {s.transcript?.substring(0, 100)}... "</div>
                    ) : s.status === 'error' ? (
                      <span className="text-red-400">{s.errorMsg}</span>
                    ) : (
                      <span className="text-neutral-600">Waiting to transcribe...</span>
                    )}
                  </div>

                  {/* Action */}
                  <div className="flex items-center gap-2">
                    {s.status === 'processing' ? (
                      <button disabled className="px-4 py-2 bg-neutral-700/50 text-emerald-500 rounded-lg text-xs font-medium flex items-center gap-2">
                        <Loader2 className="animate-spin w-3 h-3" /> Processing...
                      </button>
                    ) : s.status === 'completed' ? (
                      <button onClick={() => transcribeSingleChunk(idx)} className="px-3 py-1 bg-neutral-800 text-neutral-400 hover:text-white rounded border border-neutral-700 text-xs transition">
                        Redo
                      </button>
                    ) : (
                      <button
                        onClick={() => transcribeSingleChunk(idx)}
                        // Disable if previous not done? Optional.
                        // disabled={idx > 0 && chunkStatuses[idx-1].status !== 'completed'} 
                        className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 shadow-lg transition
                                        ${idx > 0 && chunkStatuses[idx - 1].status !== 'completed'
                            ? 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                            : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-emerald-900/20'
                          }
                                    `}
                      >
                        <Play className="w-3 h-3" /> Transcribe
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Full Transcript Preview */}
            {showPreview && hasCompletedChunks && (
              <div className="bg-neutral-900 rounded-xl border border-neutral-700 overflow-hidden">
                <div className="flex justify-between items-center px-5 py-3 border-b border-neutral-700 bg-neutral-800/50">
                  <h3 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
                    <Eye className="w-4 h-4" /> Full Transcript Preview
                  </h3>
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <span>{chunkStatuses.filter(s => s.status === 'completed').length} of {chunkStatuses.length} chunks transcribed</span>
                    <button
                      onClick={copyToClipboard}
                      className="text-neutral-400 hover:text-white flex items-center gap-1 transition"
                    >
                      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copied ? 'Copied!' : 'Copy All'}
                    </button>
                  </div>
                </div>
                <div className="p-5 max-h-[500px] overflow-y-auto">
                  <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap font-bengali text-neutral-200 leading-relaxed text-base">
                    {getFullTranscript() || <span className="text-neutral-500 italic">No transcript available yet.</span>}
                  </div>
                </div>
              </div>
            )}

            {/* Logs */}
            <div className="bg-black/40 rounded-lg p-4 font-mono text-xs text-neutral-400 h-32 overflow-y-auto">
              {apiLog.map((log, i) => (
                <div key={i}>{log}</div>
              ))}
              <div className="opacity-0">.</div>
            </div>
          </section>
        )}

      </div>
    </main>
  );
}
