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

  interface ClipWrightLibraryProject {
    contents: string;
    documentId: string;
    contentHash: string;
    fileName: string;
  }

  interface ClipWrightLibraryMediaImport {
    mode: 'managed' | 'linked';
    name: string;
    sourcePath: string;
    pathKind: 'absolute' | 'project-relative';
    fileSizeBytes: number;
    fingerprint: string;
    deduplicated?: boolean;
    mediaUrl: string;
  }

  interface ClipWrightResolvedMedia {
    assetId: string;
    available: boolean;
    mediaUrl?: string;
    sizeBytes?: number;
    reason?: string;
  }

  interface Window {
    /** Present only inside the secure Electron desktop shell. */
    clipwright?: {
      app: {
        getInfo(): Promise<ClipWrightDesktopInfo>;
      };
      exportFiles: {
        getDefaultFolder(): Promise<{ canceled: true } | { canceled: false; handle: string; folderName: string }>;
        chooseFolder(): Promise<{ canceled: true } | { canceled: false; handle: string; folderName: string }>;
        begin(payload: { handle: string; fileName: string; extension: 'mp4' | 'webm'; expectedSizeBytes: number }): Promise<{ id: string }>;
        write(payload: { id: string; position: number; bytes: Uint8Array }): Promise<{ written: number }>;
        prepare(id: string): Promise<{ sizeBytes: number }>;
        read(payload: { id: string; start: number; end: number }): Promise<Uint8Array>;
        commit(id: string): Promise<{ fileName: string; folderName: string; fileHandle: string; sizeBytes: number }>;
        abort(id: string): Promise<{ aborted: true }>;
        openFolder(fileHandle: string): Promise<{ opened: true }>;
      };
      projectFiles: {
        open(): Promise<ClipWrightProjectOpenResult>;
        saveAs(payload: { contents: string; suggestedName: string }): Promise<ClipWrightProjectSaveResult>;
        save(payload: { handle: string; contents: string }): Promise<ClipWrightProjectWriteResult>;
        listRecoveryPoints(handle: string): Promise<ClipWrightRecoveryPoint[]>;
        readRecoveryPoint(payload: { handle: string; recoveryId: string }): Promise<string>;
      };
      library: {
        initialize(): Promise<{ root: string; directories: Record<string, string>; projects: ClipWrightLibraryProject[]; issues: Array<{ directoryId: string; message: string }> }>;
        saveProject(payload: { contents: string }): Promise<{ changed: boolean; recoveryId: string | null; documentId: string; contentHash: string; projectId: string }>;
        importFile(file: File, payload: { projectId: string; assetId: string; mode: 'managed' | 'linked' }): Promise<ClipWrightLibraryMediaImport>;
        resolveMedia(projectId: string): Promise<ClipWrightResolvedMedia[]>;
        revealMedia(payload: { projectId: string; assetId: string }): Promise<{ opened: true }>;
        openDataFolder(): Promise<{ opened: true; root: string }>;
        clearCache(): Promise<{ removedEntries: number }>;
        cloneProject(payload: { sourceProjectId: string; contents: string }): Promise<{ projectId: string; contentHash: string }>;
        archiveProject(projectId: string): Promise<{ archived: boolean; mediaPreserved: true }>;
        createBackup(payload: { projectId: string; includeLinked: boolean }): Promise<{ canceled: true } | { canceled: false; backupPath: string; externalNotCollected: Array<{ assetId: string; name: string; reason?: string; sourcePath?: string }> }>;
        restoreBackup(): Promise<{ canceled: true } | { canceled: false; contents: string; documentId: string }>;
      };
    };
  }
}
