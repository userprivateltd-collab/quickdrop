/**
 * BeamDrop File Streaming & Disk Writer
 * Handles File System Access API direct streaming on Chromium (Windows, Android, Mac)
 * with robust memory safeguards and Blob fallbacks for iOS Safari.
 */

export const Capabilities = {
  hasFileSystemAccess: typeof window !== 'undefined' && 'showSaveFilePicker' in window,
  hasDirectoryPicker: typeof window !== 'undefined' && 'showDirectoryPicker' in window,
  isIOS: typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream,
  isSafari: typeof navigator !== 'undefined' && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)
};

/**
 * Check if total size poses a memory hazard on memory-constrained mobile browsers (e.g. iOS Safari)
 */
export function checkMemoryConstraint(totalBytes) {
  if (Capabilities.isIOS) {
    // iOS Safari typically caps tab memory around 1 GB - 1.5 GB
    const limitBytes = 850 * 1024 * 1024; // 850 MB
    if (totalBytes > limitBytes) {
      return {
        warning: true,
        message: 'iOS Safari has strict tab memory limits (~1 GB). Receiving files larger than 800 MB may cause Safari to reload the tab. For massive files, Android or Desktop Chrome/Edge is recommended.'
      };
    }
  }
  return { warning: false, message: '' };
}

/**
 * Optional user prompt to select a save folder via File System Access API
 * (Available on Chrome / Edge / Opera on Windows, Mac, Linux and Android)
 */
export async function requestSaveDirectory() {
  if (Capabilities.hasDirectoryPicker) {
    try {
      const dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'downloads'
      });
      return dirHandle;
    } catch (err) {
      // User cancelled picker or permission denied - will fallback to normal blob save
      console.log('[BeamDrop] Directory picker skipped or cancelled, using memory assembly.');
      return null;
    }
  }
  return null;
}

/**
 * File Receiver Session
 * Creates streaming writers per file
 */
export class FileReceiverSession {
  constructor(dirHandle = null) {
    this.dirHandle = dirHandle;
    this.currentWriter = null;
    this.completedFiles = [];
  }

  /**
   * Start receiving a file
   * @param {{ id: string, name: string, size: number, type: string }} fileInfo
   */
  async startFile(fileInfo) {
    // 1. If directory handle is available, stream directly to disk with batching
    if (this.dirHandle) {
      try {
        const fileHandle = await this.dirHandle.getFileHandle(fileInfo.name, { create: true });
        const writable = await fileHandle.createWritable();
        let writeBatch = [];
        let batchBytes = 0;
        const FLUSH_BYTES = 1024 * 1024; // 1 MB disk batch

        const flushBatch = async () => {
          if (writeBatch.length === 0) return;
          const combined = writeBatch.length === 1 ? writeBatch[0] : new Blob(writeBatch);
          writeBatch = [];
          batchBytes = 0;
          await writable.write(combined);
        };

        this.currentWriter = {
          mode: 'fsa-stream',
          fileInfo,
          fileHandle,
          writable,
          writtenBytes: 0,
          write: async (chunk) => {
            writeBatch.push(chunk);
            batchBytes += chunk.byteLength;
            this.currentWriter.writtenBytes += chunk.byteLength;
            if (batchBytes >= FLUSH_BYTES) {
              await flushBatch();
            }
          },
          finish: async () => {
            await flushBatch();
            await writable.close();
            const result = {
              id: fileInfo.id,
              name: fileInfo.name,
              size: fileInfo.size,
              type: fileInfo.type,
              savedToDisk: true,
              url: null
            };
            this.completedFiles.push(result);
            return result;
          },
          abort: async () => {
            writeBatch = [];
            try {
              await writable.abort();
            } catch (e) {}
          }
        };
        return this.currentWriter;
      } catch (err) {
        console.warn('[BeamDrop] FSA stream creation failed, falling back to memory assembly:', err);
      }
    }

    // 2. In-memory chunk collector (universal fallback for iOS Safari and browsers without FSA)
    const chunks = [];
    let receivedBytes = 0;

    this.currentWriter = {
      mode: 'memory-blob',
      fileInfo,
      writtenBytes: 0,
      write: async (chunk) => {
        // Collect chunks in ArrayBuffer or Uint8Array
        chunks.push(chunk);
        receivedBytes += chunk.byteLength;
        this.currentWriter.writtenBytes = receivedBytes;
      },
      finish: async () => {
        try {
          const blob = new Blob(chunks, { type: fileInfo.type || 'application/octet-stream' });
          chunks.length = 0; // Immediately free chunk references to release memory
          const url = URL.createObjectURL(blob);
          const result = {
            id: fileInfo.id,
            name: fileInfo.name,
            size: fileInfo.size,
            type: fileInfo.type,
            blob,
            url,
            savedToDisk: false
          };
          this.completedFiles.push(result);
          return result;
        } catch (err) {
          console.error('[BeamDrop] Memory allocation failed while creating Blob:', err);
          throw new Error('Device ran out of memory while assembling received file.');
        }
      },
      abort: async () => {
        chunks.length = 0;
      }
    };

    return this.currentWriter;
  }

  /**
   * Write chunk to active file writer
   */
  async writeChunk(chunk) {
    if (this.currentWriter) {
      await this.currentWriter.write(chunk);
    }
  }

  /**
   * Complete active file
   */
  async finishFile() {
    if (this.currentWriter) {
      const res = await this.currentWriter.finish();
      this.currentWriter = null;
      return res;
    }
    return null;
  }

  /**
   * Abort transfer and clean up
   */
  async abort() {
    if (this.currentWriter) {
      await this.currentWriter.abort();
      this.currentWriter = null;
    }
  }

  /**
   * Get all completed files in this session
   */
  getCompletedFiles() {
    return this.completedFiles;
  }
}
