import chalk from 'chalk';

// ── Demo options ────────────────────────────────────────────────────

export interface DemoOptions {
    cinematic?: boolean;
    hooks?: boolean;
    speed?: 'fast' | 'normal' | 'slow';
}

const SPEED_MULTIPLIERS: Record<string, number> = {
    fast: 0.3,
    normal: 1.0,
    slow: 1.8,
};

// ── Timing helpers ──────────────────────────────────────────────────

export function getMultiplier(options: DemoOptions): number {
    return SPEED_MULTIPLIERS[options.speed || 'normal'] || 1.0;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pause(ms: number, options: DemoOptions): Promise<void> {
    await sleep(ms * getMultiplier(options));
}

// ── Typewriter effect ───────────────────────────────────────────────

export async function typewrite(
    text: string,
    options: DemoOptions,
    charDelay = 18
): Promise<void> {
    if (!options.cinematic) {
        process.stdout.write(text + '\n');
        return;
    }
    const delay = charDelay * getMultiplier(options);
    for (const char of text) {
        process.stdout.write(char);
        await sleep(delay);
    }
    process.stdout.write('\n');
}

