import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

export interface AudioChunk {
    index: number;
    blob: Blob;
    startTime: number;
    endTime: number;
    duration: number;
}

let ffmpeg: FFmpeg | null = null;

// Function to load FFmpeg.wasm
export async function loadFFmpeg() {
    if (ffmpeg) return ffmpeg;

    ffmpeg = new FFmpeg();

    // Load from local public/ffmpeg directory
    const baseURL = '/ffmpeg'; // Path relative to public

    // Note: Ensure core files exist in public/ffmpeg
    await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    return ffmpeg;
}

// Helper to get audio duration via HTMLAudioElement
function getDuration(file: File): Promise<number> {
    return new Promise((resolve, reject) => {
        const audio = document.createElement('audio');
        const objectUrl = URL.createObjectURL(file);
        audio.src = objectUrl;

        audio.onloadedmetadata = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(audio.duration);
        };

        audio.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            // Fallback or reject. Let's reject for now as duration is critical.
            reject(new Error("Could not determine audio duration"));
        };
    });
}

export async function processAudioFile(
    file: File,
    onProgress: (progress: number, message: string) => void
): Promise<AudioChunk[]> {
    const ffmpeg = await loadFFmpeg();

    const inputName = 'input.' + (file.name.split('.').pop() || 'mp3');
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    let duration = 0;
    try {
        duration = await getDuration(file);
    } catch (e) {
        onProgress(0, "Warning: Could not get precise duration, using limit...");
        duration = 3600 * 3; // 3 hours limit fallback
    }

    const SEGMENT_TIME = 600; // 10 mins (safer for quotas)
    const chunks: AudioChunk[] = [];
    const OVERLAP = 2; // 2 seconds overlap

    let currentTime = 0;
    let index = 0;

    // Loop through duration
    while (currentTime < duration) {
        // Determine chunk end
        let chunkEnd = Math.min(currentTime + SEGMENT_TIME, duration);
        const chunkDuration = chunkEnd - currentTime;

        if (chunkDuration <= 0) break;

        onProgress(
            Math.min(0.99, currentTime / duration),
            `Processing chunk ${index + 1} (${Math.round(currentTime / 60)}m - ${Math.round(chunkEnd / 60)}m)...`
        );

        const outputName = `chunk_${index}.mp3`;

        // Command to extract segment and convert to 16k mono 64k bitratemp3
        // -ss is seek start, -t is duration
        // Using -ss before input for fast seek (keyframe based for some formats, might be slightly inaccurate but much faster)
        // Actually, for precise cutting, -ss after input is better but slower.
        // Given client-side constraints, let's try input seeking first.
        // If we want re-encoding, we should output mp3.

        await ffmpeg.exec([
            '-i', inputName,
            '-ss', currentTime.toString(),
            '-t', chunkDuration.toString(),
            '-ac', '1', // mono
            '-ar', '16000', // 16kHz
            '-b:a', '64k', // 64kbps CBR
            '-map', '0:a',
            outputName
        ]);

        // Read the result
        const data = await ffmpeg.readFile(outputName);
        const blob = new Blob([data as any], { type: 'audio/mp3' });

        // Safety check size
        if (blob.size > 24 * 1024 * 1024) {
            // If > 24MB, this 20 min chunk is huge.
            // 64kbps * 1200s is ~9.6MB. So strict 24MB limit is safe.
            // But if user provided a file that results in huge size (e.g. metadata?), unlikely with ffmpeg re-encode.
            console.warn(`Chunk ${index} is large: ${(blob.size / 1024 / 1024).toFixed(2)}MB`);
        }

        chunks.push({
            index,
            blob,
            startTime: currentTime,
            endTime: chunkEnd,
            duration: chunkDuration
        });

        // Clean up chunk file to free memory
        await ffmpeg.deleteFile(outputName);

        // Update time for next chunk
        // Next chunk starts at current end minus overlap
        // But we must advance forward! 
        // If we just subtract overlap, we are moving forward by (SEGMENT - OVERLAP).
        currentTime = chunkEnd - OVERLAP;

        // Break if we are at the end
        if (chunkEnd >= duration) break;

        index++;
    }

    // Cleanup input file
    await ffmpeg.deleteFile(inputName);

    onProgress(1, 'All chunks processed.');
    return chunks;
}
