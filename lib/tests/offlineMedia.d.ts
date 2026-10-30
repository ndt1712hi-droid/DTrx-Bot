/** Bot construction eagerly initializes both music providers. Unit tests that
 * do not exercise network playback must not create dozens of live HTTP calls. */
export declare function mockBackgroundMediaInitialization(): () => void;
