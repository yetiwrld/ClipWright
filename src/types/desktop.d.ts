export {};

declare global {
  interface ClipWrightDesktopInfo {
    name: string;
    version: string;
    platform: string;
    packaged: boolean;
  }

  interface Window {
    /** Present only inside the secure Electron desktop shell. */
    clipwright?: {
      app: {
        getInfo(): Promise<ClipWrightDesktopInfo>;
      };
    };
  }
}
