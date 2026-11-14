export declare const OXIPNG_VERSION: string;
export declare const OXIPNG_LEVEL: string;
export declare const OXIPNG_TAG: string;
export interface OxipngStats { files: number; before: number; after: number; hits: number; misses: number; ms: number }
export declare function ensureOxipng(toolDir: string): string | undefined;
export declare function optimizeDistPngs(distDir: string, opts: { cacheDir: string; toolDir: string; mode?: string; log?: (s: string) => void }): OxipngStats;
