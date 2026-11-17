export declare const SCREEN_SPECS: Record<string, {
    pixels: string;
    dpi?: string;
}>;
export declare function findScreenSpec(query: string): {
    name: string;
    pixels: string;
    dpi?: string;
} | null;
