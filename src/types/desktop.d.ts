export {};

declare global {
  interface ClipWrightDesktopInfo {
    name: string;
    version: string;
    platform: string;
    packaged: boolean;
  }

  interface ClipWrightProjectWriteResult {
    changed: boolean;
    recoveryId: string | null;
    documentId: string;
    fileName: string;
  }

  type ClipWrightProjectSaveResult =
    | { canceled: true }
    | ({ canceled: false; handle: string } & ClipWrightProjectWriteResult);

  type ClipWrightProjectOpenResult =
    | { canceled: true }
    | { canceled: false; handle: string; fileName: string; contents: string; documentId: string };

  interface ClipWrightRecoveryPoint {
    id: string;
    modifiedAt: string;
    sizeBytes: number;
  }

  interface Window {
    /** Present only inside the secure Electron desktop shell. */
    clipwright?: {
      app: {
        getInfo(): Promise<ClipWrightDesktopInfo>;
      };
      projectFiles: {
        open(): Promise<ClipWrightProjectOpenResult>;
        saveAs(payload: { contents: string; suggestedName: string }): Promise<ClipWrightProjectSaveResult>;
        save(payload: { handle: string; contents: string }): Promise<ClipWrightProjectWriteResult>;
        listRecoveryPoints(handle: string): Promise<ClipWrightRecoveryPoint[]>;
        readRecoveryPoint(payload: { handle: string; recoveryId: string }): Promise<string>;
      };
    };
  }
}
