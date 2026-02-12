export function sanitizeFilename(originalName: string): string {
    // Remove extension
    const nameWithoutExt = originalName.substring(0, originalName.lastIndexOf('.')) || originalName;
    // Replace unsafe chars with consistent separator, keep alphanumeric, spaces, hyphens
    const safeName = nameWithoutExt
        .replace(/[^a-z0-9\u0980-\u09FF \-_]/gi, '') // Keep Bengali chars (\u0980-\u09FF), alphanumeric, space, hyphen, underscore
        .trim()
        .replace(/\s+/g, '_'); // Replace spaces with underscores

    return safeName || 'audio_transcript';
}

export function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const hStr = h > 0 ? `${h}h ` : '';
    const mStr = `${m}m `;
    const sStr = `${s}s`;

    return `${hStr}${mStr}${sStr}`.trim();
}

export function formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
