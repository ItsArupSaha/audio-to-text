type ModelType = 'whisper-large-v3' | 'whisper-large-v3-turbo';

interface QuotaState {
    version: number; // For future migrations
    hourly: {
        [key in ModelType]: {
            used: number; // Seconds used in current window
            windowStart: number; // Timestamp of window start
        };
    };
    daily: {
        [key in ModelType]: {
            used: number; // Seconds used in current day
            lastReset: number; // Timestamp of last daily reset
        };
    };
}

const STORAGE_KEY = 'groq_quota_tracker_v1';

// Limits in seconds
const LIMITS = {
    HOURLY: 7200, // 2 hours
    DAILY: 28800, // 8 hours
};

const DEFAULT_STATE: QuotaState = {
    version: 1,
    hourly: {
        'whisper-large-v3': { used: 0, windowStart: Date.now() },
        'whisper-large-v3-turbo': { used: 0, windowStart: Date.now() },
    },
    daily: {
        'whisper-large-v3': { used: 0, lastReset: Date.now() },
        'whisper-large-v3-turbo': { used: 0, lastReset: Date.now() },
    },
};

export class QuotaManager {
    private state: QuotaState;

    constructor() {
        this.state = this.loadState();
        this.checkResets();
    }

    private loadState(): QuotaState {
        if (typeof window === 'undefined') return DEFAULT_STATE;
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : DEFAULT_STATE;
        } catch (e) {
            console.error('Failed to load quota state', e);
            return DEFAULT_STATE;
        }
    }

    private saveState() {
        if (typeof window === 'undefined') return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
        } catch (e) {
            console.error('Failed to save quota state', e);
        }
    }

    private checkResets() {
        const now = Date.now();
        let changed = false;

        // Hourly Reset (Rolling or Fixed Window? Plan said "Reset locally after 60 mins from start")
        // Let's do a simplified checking: if windowStart is > 1 hour ago, reset.
        (['whisper-large-v3', 'whisper-large-v3-turbo'] as ModelType[]).forEach(model => {
            if (now - this.state.hourly[model].windowStart > 3600 * 1000) {
                this.state.hourly[model].used = 0;
                this.state.hourly[model].windowStart = now;
                changed = true;
            }

            // Daily Reset (Midnight)
            // Check if lastReset is a different day than today
            const lastDate = new Date(this.state.daily[model].lastReset);
            const currentDate = new Date(now);
            if (lastDate.getDate() !== currentDate.getDate() || lastDate.getMonth() !== currentDate.getMonth()) {
                this.state.daily[model].used = 0;
                this.state.daily[model].lastReset = now;
                changed = true;
            }
        });

        if (changed) this.saveState();
    }

    public canProcess(durationSec: number, model: ModelType): boolean {
        this.checkResets();

        // Safety buffer: reserve 1 minute
        const buffer = 60;
        const estimatedCost = durationSec;

        // Check hourly
        const hourlyUsed = this.state.hourly[model].used;
        if (hourlyUsed + estimatedCost > LIMITS.HOURLY - buffer) return false;

        // Check daily
        const dailyUsed = this.state.daily[model].used;
        if (dailyUsed + estimatedCost > LIMITS.DAILY - buffer) return false;

        return true;
    }

    public recordUsage(durationSec: number, model: ModelType) {
        this.checkResets(); // Ensure we are in correct window before adding
        this.state.hourly[model].used += durationSec;
        this.state.daily[model].used += durationSec;
        this.saveState();
    }

    public getRemaining(model: ModelType): { hourly: number, daily: number } {
        this.checkResets();
        const h = Math.max(0, LIMITS.HOURLY - this.state.hourly[model].used);
        const d = Math.max(0, LIMITS.DAILY - this.state.daily[model].used);
        return { hourly: h, daily: d };
    }

    public getPreferredModel(durationSec: number): ModelType | null {
        if (this.canProcess(durationSec, 'whisper-large-v3')) return 'whisper-large-v3';
        if (this.canProcess(durationSec, 'whisper-large-v3-turbo')) return 'whisper-large-v3-turbo';
        return null; // Both exhausted
    }

    public updateFromHeaders(headers: Record<string, string>, model: ModelType) {
        // Log all headers for debugging/visibility
        console.log(`[QuotaManager] Headers for ${model}:`, headers);

        // Try to find specific audio remaining header
        // Groq headers: x-ratelimit-remaining-audio-seconds ?
        // Or generic: x-ratelimit-remaining-requests

        // If we find audio-seconds, we trust it absolutely.
        // It seems Groq might imply audio limits via standard headers if the model is audio?
        // Let's look for "x-ratelimit-remaining-audio-seconds" or "x-ratelimit-remaining-audio"

        // We will do a fuzzy match or check known keys
        const remainingAudio = headers['x-ratelimit-remaining-audio-seconds'] || headers['x-ratelimit-remaining-audio'];

        if (remainingAudio) {
            const remaining = parseFloat(remainingAudio);
            if (!isNaN(remaining)) {
                // Sync hourly usage. 
                // We don't know the exact limit from header usually (unless x-ratelimit-limit-audio-seconds exists)
                // But we can set used = LIMIT - remaining.
                // Assuming LIMIT is consistent with our constants.
                // If headers say 3600 remaining, and our limit is 7200, then used is 3600.
                // This assumes our LIMIT constant matches Groq's actual limit.
                // If Groq limit is different, our percentage might be off, but "remaining" is what matters.

                // Better: Store "serverRemaining" and use that for "canProcess" if available?
                // But we need to mix local tracking for the *next* chunk before we get a response.

                // Strategy: Re-calibrate 'used' based on standard limit.
                const limit = LIMITS.HOURLY; // or DAILY? likely hourly is the bottleneck usually described as ASH.
                // Actually headers often have "reset" time. If reset is soon, it's hourly?
                // Let's assume the header refers to the rolling window or hourly.

                // Let's just blindly update 'used' for hourly to be safe.
                // used = 7200 - remaining.
                // Check if it's daily? headers usually specify window or we can guess.
                // For now, let's just log and IF explicit, use it.

                this.state.hourly[model].used = Math.max(0, LIMITS.HOURLY - remaining);
                this.state.hourly[model].windowStart = Date.now(); // Reset window start to now since we have fresh data? No, keep window.
                this.saveState();
            }
        }
    }

    public updateFromError(errorMessage: string, model: ModelType) {
        // Parse: "Limit 7200, Used 7155, Requested 1200"
        // Regex to find "Limit <num>, Used <num>"
        const limitMatch = errorMessage.match(/Limit\s+(\d+(?:\.\d+)?)/);
        const usedMatch = errorMessage.match(/Used\s+(\d+(?:\.\d+)?)/);

        if (limitMatch && usedMatch) {
            const limit = parseFloat(limitMatch[1]);
            const used = parseFloat(usedMatch[1]);

            // If the error says we used X, we trust it.
            // But we need to map it to our hourly/daily buckets.
            // The error usually specifies "seconds of audio per hour" (ASPH) or "per day" (ASPD).

            if (errorMessage.includes("per hour") || errorMessage.includes("ASPH")) {
                this.state.hourly[model].used = used;
                // If we exceeded, maybe set it to limit to prevent immediate retry?
                // Actually, set it to `used`.
            } else if (errorMessage.includes("per day") || errorMessage.includes("ASPD")) {
                this.state.daily[model].used = used;
            } else {
                // Unknown period, assume hourly as it's most common blocker
                this.state.hourly[model].used = used;
            }
            this.saveState();
        } else {
            // Fallback: if we hit rate limit but can't parse, allow simple backoff?
            // Maximizing usage to force switch
            this.state.hourly[model].used = LIMITS.HOURLY;
            this.saveState();
        }
    }
}

export const quotaManager = new QuotaManager();
