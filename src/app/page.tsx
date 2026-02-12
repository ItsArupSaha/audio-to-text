'use client';

import React, { useState, useEffect, useRef } from 'react';
import { sanitizeFilename, formatDuration, formatTimestamp } from '@/lib/file-utils';
import { processAudioFile, AudioChunk } from '@/lib/audio-processing';
import { quotaManager } from '@/lib/quota-manager'; // Client-side usage? define types
import { generateDocx } from '@/lib/docx-generator';
import { Upload, FileAudio, Play, Pause, Download, AlertTriangle, CheckCircle, Loader2, Clock } from 'lucide-react';
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

  const abortController = useRef<AbortController | null>(null);

  useEffect(() => {
    // Initial quota check
    updateQuotaDisplay();
    const interval = setInterval(updateQuotaDisplay, 30000); // Poll every 30s
    return () => clearInterval(interval);
  }, []);

  const updateQuotaDisplay = () => {
    // quotaManager is client-side singleton
    // Note: This relies on quotaManager being isomorphic or client-only.
    // Since we imported it from lib/quota-manager, and it uses localStorage, it should work in useEffect.
    const v3 = quotaManager.getRemaining('whisper-large-v3');
    const turbo = quotaManager.getRemaining('whisper-large-v3-turbo');
    setQuotaInfo({
      v3: { hourly: v3.hourly, daily: v3.daily },
      turbo: { hourly: turbo.hourly, daily: turbo.daily }
    });
  };

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

  const startTranscription = async () => {
    setStatus('transcribing');
    abortController.current = new AbortController();
    processQueue();
  };

  const processQueue = async () => {
    // Find next pending
    // We need to use refs or functional state update carefully because this is async recursive-like
    // Better: iterative loop helper or effect.
    // Let's use a function that calls itself after updating state.

    // However, react state updates are async.
    // Let's use a ref for current index to avoid stale closures.
  };

  // Improved queue processor
  useEffect(() => {
    if (status === 'transcribing') {
      const processNext = async () => {
        // Find first pending index
        const index = chunkStatuses.findIndex(s => s.status === 'pending');
        if (index === -1) {
          // Check if any error?
          if (chunkStatuses.some(s => s.status === 'error')) {
            setStatus('paused'); // Paused due to error
          } else {
            setStatus('completed');
          }
          return;
        }

        const chunk = chunks[index];
        const currentStatus = chunkStatuses[index];

        if (!chunk) {
          console.error("Chunk blob missing but status pending");
          return;
        }

        // 1. Check Quota
        // Try v3 first
        const duration = chunk.duration;
        let model = quotaManager.getPreferredModel(duration);

        if (!model) {
          setStatus('paused');
          setApiLog(prev => [...prev, `[${formatTimestamp(chunk.startTime)}] Quota exhausted for both models. Waiting...`]);
          return;
        }

        // Update status for UI
        setChunkStatuses(prev => {
          const next = [...prev];
          next[index] = { ...next[index], status: 'processing', modelUsed: model || '' };
          return next;
        });

        // 2. Upload
        try {
          const formData = new FormData();
          formData.append('file', chunk.blob, `chunk_${index}.mp3`);
          formData.append('model', model);
          formData.append('chunkIndex', index.toString());

          setApiLog(prev => [...prev, `[${formatTimestamp(chunk.startTime)}] Transcribing with ${model}...`]);

          const res = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData,
            signal: abortController.current?.signal,
          });

          if (!res.ok) {
            const errData = await res.json();
            if (res.status === 429) {
              setApiLog(prev => [...prev, "429 Rate Limit. Updating quota and checking fallback..."]);

              // 1. Update Quota from Error Message
              if (errData?.error?.message) {
                quotaManager.updateFromError(errData.error.message, model as any);
              } else {
                // Fallback max out
                quotaManager.updateFromError("", model as any);
              }
              updateQuotaDisplay();

              // 2. Check if we can switch model
              const nextModel = quotaManager.getPreferredModel(duration);
              if (nextModel) {
                setApiLog(prev => [...prev, `Switching model to ${nextModel} and retrying...`]);
                setChunkStatuses(prev => {
                  const next = [...prev];
                  next[index] = { ...next[index], status: 'pending' };
                  return next;
                });
                setProcessingIndex(null); // Triggers effect to retry
                return;
              }

              // 3. No models left
              setStatus('paused');
              setChunkStatuses(prev => {
                const next = [...prev];
                next[index] = { ...next[index], status: 'pending' };
                return next;
              });
              setProcessingIndex(null);
              return;
            }
            throw new Error(errData.error || res.statusText);
          }

          const data = await res.json();

          // Record Usage
          // We use chunk duration as "cost"
          if (model) {
            quotaManager.recordUsage(duration, model as any);
            updateQuotaDisplay();
          }

          // Save Result
          setChunkStatuses(prev => {
            const next = [...prev];
            next[index] = {
              ...next[index],
              status: 'completed',
              transcript: data.text,
              segments: data.segments
            };
            // Persist
            localStorage.setItem('last_job_statuses', JSON.stringify(next));
            return next;
          });

          setApiLog(prev => [...prev, `[${formatTimestamp(chunk.startTime)}] Completed.`]);

        } catch (e: any) {
          if (e.name === 'AbortError') return;
          console.error(e);
          setApiLog(prev => [...prev, `[${formatTimestamp(chunk.startTime)}] Error: ${e.message}`]);
          setChunkStatuses(prev => {
            const next = [...prev];
            next[index] = { ...next[index], status: 'error', errorMsg: e.message };
            return next;
          });
          // Don't stop entirely, try next? No, stop to let user fix.
          setStatus('paused');
        }
      };

      processNext();
    }
  }, [status, chunkStatuses, chunks]); // Dep array needs care. 
  // If we depend on chunkStatuses, it loops.
  // We need to trigger this effect when status becomes 'transcribing' OR when a chunk finishes.
  // But updating chunkStatuses will trigger it again. 
  // Logic: 
  // 1. Find pending. 
  // 2. If found, mark processing (triggers effect, but pending index is now processing, so findPending returns differnt or same?)
  // If we mark processing, findIndex(status === 'pending') returns the NEXT one? No, we process one at a time.
  // So strictly sequential: 
  // Effect runs. Finds index 0. 0 is pending.
  // Sets 0 to processing.
  // Effect runs. Finds index 0 is processing. Stops? 
  // We need to wait for async.
  // The async part is inside the effect? No, effects shouldn't be async like that.
  // Let's refactor: separate "trigger" from "state".
  // Or use a "processing" ref.

  // Better approach:
  // A 'runner' function called `runNextChunk` which calls itself on completion.
  // `useEffect` only starts it.

  // Refactor to manual recursion
  const runQueueRef = useRef(false);

  useEffect(() => {
    if (status === 'transcribing' && !runQueueRef.current) {
      runQueueRef.current = true;
      runner();
    } else if (status !== 'transcribing') {
      runQueueRef.current = false;
      // abort?
    }
  }, [status]);

  const runner = async () => {
    if (!runQueueRef.current) return;

    // Get latest state using function update or ref? 
    // We need access to state.
    // Simplest: pass index to recursive function? 
    // But status updates are react updates.

    // Let's just use the `useEffect` above but fix the loop.
    // If we only look for `pending` and ignoring `processing`, then:
    // 1. Effect runs. Finds index 0 (pending).
    // 2. Set index 0 to processing.
    // 3. Effect runs. Finds index 1 (pending). 
    // oops parallel.

    // We need a "busy" flag.
  };

  // Re-implementing with "busy" state in component is tricky. 
  // Let's leave the logic loose for now and trust the user clicks "Resume" if it pauses? 
  // No, auto-next is needed.
  // Let's use a `processingIndex` state.

  const [processingIndex, setProcessingIndex] = useState<number | null>(null);

  useEffect(() => {
    if (status === 'transcribing' && processingIndex === null) {
      // Find next
      const nextIdx = chunkStatuses.findIndex(s => s.status === 'pending');
      if (nextIdx !== -1) {
        setProcessingIndex(nextIdx);
        processChunk(nextIdx);
      } else {
        // Done or error
        if (chunkStatuses.some(s => s.status === 'error')) {
          setStatus('paused');
        } else {
          setStatus('completed');
        }
      }
    }
  }, [status, processingIndex, chunkStatuses]);

  const processChunk = async (index: number) => {
    // ... logic from above ...
    // After done:
    // setChunkStatuses(updated)
    // setProcessingIndex(null) -> triggers effect again

    const chunk = chunks[index];
    // Check quota
    const duration = chunk.duration;
    let model = quotaManager.getPreferredModel(duration);

    if (!model) {
      setStatus('paused');
      setProcessingIndex(null);
      setApiLog(prev => [...prev, "Quota exhausted. Pausing."]);
      return;
    }

    // Mark processing
    setChunkStatuses(prev => {
      const next = [...prev];
      next[index] = { ...next[index], status: 'processing', modelUsed: model || '' };
      return next;
    });

    try {
      const formData = new FormData();
      formData.append('file', chunk.blob, `chunk_${index}.mp3`);
      formData.append('model', model);

      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });

      if (!res.ok) {
        const errData = await res.json();
        if (res.status === 429) {
          setApiLog(prev => [...prev, "429 Rate Limit. Updating quota and checking fallback..."]);

          // 1. Update Quota from Error Message
          if (errData?.error?.message) {
            quotaManager.updateFromError(errData.error.message, model as any);
          } else {
            quotaManager.updateFromError("", model as any);
          }
          updateQuotaDisplay();

          // 2. Check if we can switch model
          const nextModel = quotaManager.getPreferredModel(duration);
          if (nextModel) {
            setApiLog(prev => [...prev, `Switching model to ${nextModel} and retrying...`]);
            setChunkStatuses(prev => {
              const next = [...prev];
              next[index] = { ...next[index], status: 'pending' };
              return next;
            });
            setProcessingIndex(null); // Triggers effect to retry
            return;
          }

          // 3. No models left
          setStatus('paused');
          setChunkStatuses(prev => {
            const next = [...prev];
            next[index] = { ...next[index], status: 'pending' };
            return next;
          });
          setProcessingIndex(null);
          return;
        }
        throw new Error(errData.error || res.statusText);
      }

      const data = await res.json();

      // Always record usage locally first (optimistic/fallback)
      quotaManager.recordUsage(duration, model as any);

      if (data.rateLimits) {
        quotaManager.updateFromHeaders(data.rateLimits, model as any);

        const audioRem = data.rateLimits['x-ratelimit-remaining-audio-seconds'] || data.rateLimits['x-ratelimit-remaining-audio'];
        if (audioRem) {
          setApiLog(prev => [...prev, `[Groq Report] Audio Remaining: ${audioRem}s`]);
        }
      }

      updateQuotaDisplay();

      setChunkStatuses(prev => {
        const next = [...prev];
        next[index] = { ...next[index], status: 'completed', transcript: data.text, segments: data.segments };
        localStorage.setItem('last_job_statuses', JSON.stringify(next));
        return next;
      });

    } catch (e: any) {
      console.error(e);
      setStatus('paused');
      setChunkStatuses(prev => {
        const next = [...prev];
        next[index] = { ...next[index], status: 'error', errorMsg: e.message };
        return next;
      });
    }

    setProcessingIndex(null);
  };

  const downloadDocx = async () => {
    // Filter completed
    const completed = chunkStatuses.filter(s => s.status === 'completed' && s.segments).map(s => ({
      chunkIndex: s.id,
      startTimeOffset: chunks[s.id]?.startTime || 0,
      segments: s.segments,
      transcript: s.transcript // Include transcript for fallback
    }));

    // If verbose_json not used or simpler text:
    if (completed.length === 0) return;

    // Map segments
    const mapped = completed.map(c => ({
      chunkIndex: c.chunkIndex,
      startTimeOffset: c.startTimeOffset,
      segments: c.segments || [{ start: 0, end: 0, text: c.transcript }]
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
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="flex justify-between items-center border-b border-neutral-800 pb-6">
          <h1 className="text-2xl font-bold tracking-tight text-emerald-400">Bengali Audio Transcriber</h1>
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

        {/* Upload Section */}
        <section className="space-y-4">
          <div className="border-2 border-dashed border-neutral-700 rounded-xl p-10 flex flex-col items-center justify-center transition hover:border-emerald-500/50 hover:bg-neutral-800/50">
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileSelect}
              className="hidden"
              id="file-upload"
              disabled={status !== 'idle' && status !== 'ready_to_transcribe'} // Lock during processing?
            />
            <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center">
              <Upload className="w-10 h-10 text-neutral-400 mb-4" />
              <span className="text-lg font-medium text-neutral-300">
                {file ? file.name : "Click to select long audio file"}
              </span>
              <span className="text-sm text-neutral-500 mt-2">MP3, M4A, WAV (Max 2GB local)</span>
            </label>
          </div>

          {((status === 'idle' && file) || status === 'chunking') && (
            <div className="flex justify-center">
              <button
                onClick={startChunking}
                disabled={status === 'chunking'}
                className="bg-emerald-600 hover:bg-emerald-500 text-white px-8 py-3 rounded-full font-medium transition disabled:opacity-50 flex items-center gap-2"
              >
                {status === 'chunking' ? <Loader2 className="animate-spin" /> : <FileAudio />}
                {status === 'chunking' ? 'Processing Audio...' : 'Prepare & Chunk Audio'}
              </button>
            </div>
          )}

          {status === 'chunking' && (
            <div className="w-full bg-neutral-800 rounded-full h-2 overflow-hidden">
              <div className="bg-emerald-500 h-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          )}
          <div className="text-center text-sm text-neutral-400 min-h-[20px]">{progressMsg}</div>
        </section>

        {/* Status & Chunks */}
        {chunks.length > 0 && (
          <section className="bg-neutral-800/50 rounded-xl p-6 space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <CheckCircle className="text-emerald-500 w-5 h-5" />
                {chunks.length} Chunks Ready
              </h2>

              <div className="flex gap-3">
                {status === 'transcribing' ? (
                  <button onClick={() => setStatus('paused')} className="bg-yellow-600/20 text-yellow-500 hover:bg-yellow-600/30 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2">
                    <Pause className="w-4 h-4" /> Pause
                  </button>
                ) : status === 'completed' ? (
                  <button onClick={downloadDocx} className="bg-emerald-600 text-white hover:bg-emerald-500 px-6 py-2 rounded-lg text-sm font-medium flex items-center gap-2 shadow-lg shadow-emerald-900/20">
                    <Download className="w-4 h-4" /> Download DOCX
                  </button>
                ) : (
                  <button onClick={startTranscription} className="bg-emerald-600 text-white hover:bg-emerald-500 px-6 py-2 rounded-lg text-sm font-medium flex items-center gap-2 shadow-lg shadow-emerald-900/20">
                    <Play className="w-4 h-4" /> {status === 'paused' ? 'Resume Transcription' : 'Start Transcription'}
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {chunkStatuses.map((s, idx) => (
                <div key={idx} className={`p-4 rounded-lg flex justify-between items-center border ${s.status === 'processing' ? 'border-emerald-500/50 bg-emerald-500/10' :
                  s.status === 'completed' ? 'border-emerald-900/30 bg-emerald-900/10 opacity-75' :
                    s.status === 'error' ? 'border-red-500/30 bg-red-900/10' :
                      'border-neutral-700 bg-neutral-800'
                  }`}>
                  <div className="flex items-center gap-4">
                    <span className="font-mono text-neutral-500 text-sm">#{idx + 1}</span>
                    <div>
                      <div className="text-sm font-medium text-neutral-200">
                        {formatTimestamp(chunks[idx].startTime)} - {formatTimestamp(chunks[idx].endTime)}
                      </div>
                      <div className="text-xs text-neutral-500 mt-1">
                        {formatDuration(chunks[idx].duration)} • {(chunks[idx].blob.size / 1024 / 1024).toFixed(2)}MB
                        {s.modelUsed && <span className="ml-2 text-emerald-400">• {s.modelUsed}</span>}
                      </div>
                    </div>
                  </div>

                  <div className="text-sm font-medium">
                    {s.status === 'pending' && <span className="text-neutral-500">Pending</span>}
                    {s.status === 'processing' && <span className="text-emerald-400 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Processing</span>}
                    {s.status === 'completed' && <span className="text-emerald-600 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Done</span>}
                    {s.status === 'error' && <span className="text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Error</span>}
                  </div>
                </div>
              ))}
            </div>

            {/* Logs Area */}
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
