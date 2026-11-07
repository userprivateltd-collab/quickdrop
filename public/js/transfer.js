/**
 * BeamDrop File Transfer Engine
 * High-performance streaming file pipeline with backpressure flow control,
 * memory-safe chunking, real-time metrics, and bidirectional cancellation.
 */

import { FileReceiverSession } from './fs-stream.js';
import { requestWakeLock, releaseWakeLock } from './wake-lock.js';

// Tunable constants for maximum P2P Wi-Fi throughput
export const CHUNK_SIZE = 64 * 1024; // 64 KB per packet (universally safe MTU across iOS Safari, Android, and Desktop)
export const BLOCK_READ_SIZE = 1024 * 1024; // 1 MB disk read block to eliminate file slicing promise overhead
export const BUFFERED_AMOUNT_HIGH = 2 * 1024 * 1024; // 2 MB safe high watermark (under 16 MB browser limit)
export const BUFFERED_AMOUNT_LOW = 512 * 1024; // 512 KB low watermark to resume without draining socket queue

/**
 * Metrics Calculator
 * Smooths real-time byte measurements to calculate live MB/s, percent, and ETA
 */
export class TransferMetrics {
  constructor(totalBytes) {
    this.totalBytes = totalBytes || 1;
    this.transferredBytes = 0;
    this.startTime = performance.now();
    this.lastSampleTime = this.startTime;
    this.lastSampleBytes = 0;
    this.currentSpeed = 0; // Bytes/sec
  }

  update(transferredBytes) {
    this.transferredBytes = transferredBytes;
    const now = performance.now();
    const timeDelta = (now - this.lastSampleTime) / 1000;

    // Sample every 200ms for stable and responsive live speed updates
    if (timeDelta >= 0.20) {
      const bytesDelta = transferredBytes - this.lastSampleBytes;
      const instantSpeed = bytesDelta / timeDelta;

      if (this.currentSpeed === 0) {
        this.currentSpeed = instantSpeed;
      } else {
        this.currentSpeed = 0.70 * instantSpeed + 0.30 * this.currentSpeed;
      }

      this.lastSampleTime = now;
      this.lastSampleBytes = transferredBytes;
    }

    const percent = Math.min(100, (this.transferredBytes / this.totalBytes) * 100);
    const remainingBytes = Math.max(0, this.totalBytes - this.transferredBytes);
    const etaSeconds = this.currentSpeed > 0 ? remainingBytes / this.currentSpeed : 0;
    const totalElapsedSec = (now - this.startTime) / 1000;
    const avgSpeed = totalElapsedSec > 0 ? this.transferredBytes / totalElapsedSec : 0;

    return {
      transferredBytes: this.transferredBytes,
      totalBytes: this.totalBytes,
      percent,
      speed: this.currentSpeed,
      avgSpeed,
      etaSeconds,
      elapsedSeconds: totalElapsedSec
    };
  }
}

/**
 * File Transfer Sender
 */
export class TransferSender {
  /**
   * @param {RTCDataChannel} dataChannel
   * @param {File[]} files
   * @param {Object} options - callbacks { onProgress, onFileStart, onFileComplete, onComplete, onError, onCancel }
   */
  constructor(dataChannel, files, options = {}) {
    this.dataChannel = dataChannel;
    this.files = Array.from(files);
    this.options = options;
    this.transferId = 'tx_' + Date.now();
    this.isCancelled = false;
    this.totalSize = this.files.reduce((acc, f) => acc + f.size, 0);
    this.metrics = new TransferMetrics(this.totalSize);
    this.currentFileIndex = 0;
    this.pendingFileAckResolver = null;
  }

  /**
   * Wait for dataChannel buffer to drain below threshold
   * Includes safety timer & polling so iOS Safari never freezes
   */
  waitForBackpressure() {
    if (this.dataChannel.bufferedAmount <= BUFFERED_AMOUNT_LOW) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        try {
          this.dataChannel.removeEventListener('bufferedamountlow', onLow);
        } catch (e) {}
        clearInterval(pollInterval);
        clearTimeout(safetyTimeout);
        resolve();
      };

      const onLow = () => cleanup();

      try {
        this.dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
        this.dataChannel.addEventListener('bufferedamountlow', onLow, { once: true });
      } catch (e) {}

      // Fast 20ms poll interval fallback in case bufferedamountlow event is delayed or dropped
      const pollInterval = setInterval(() => {
        if (this.dataChannel.bufferedAmount <= BUFFERED_AMOUNT_LOW) {
          cleanup();
        }
      }, 20);

      // Max safety timeout (200ms) ensuring the pipeline never halts indefinitely
      const safetyTimeout = setTimeout(cleanup, 200);
    });
  }

  /**
   * Handle incoming message on data channel (for file acknowledgments)
   */
  handleMessage(eventOrData) {
    const data = eventOrData && eventOrData.data !== undefined ? eventOrData.data : eventOrData;
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.action === 'FILE_ACK') {
          if (this.pendingFileAckResolver) {
            this.pendingFileAckResolver();
            this.pendingFileAckResolver = null;
          }
        } else if (msg.action === 'TRANSFER_CANCEL') {
          this.isCancelled = true;
          if (this.options.onCancel) {
            this.options.onCancel(msg.reason || 'Transfer cancelled by recipient.');
          }
        }
      } catch (e) {}
    }
  }

  /**
   * Execute transfer of all selected files
   */
  async start() {
    await requestWakeLock();

    try {
      // 1. Send transfer start announcement
      this.dataChannel.send(JSON.stringify({
        action: 'TRANSFER_START',
        transferId: this.transferId,
        totalFiles: this.files.length,
        totalSize: this.totalSize
      }));

      let cumulativeTransferred = 0;
      let lastProgressReportTime = 0;

      for (let i = 0; i < this.files.length; i++) {
        if (this.isCancelled) break;

        const file = this.files[i];
        this.currentFileIndex = i;
        const fileId = `f_${i}_${file.size}_${Date.now()}`;

        if (this.options.onFileStart) {
          this.options.onFileStart({
            fileIndex: i,
            fileName: file.name,
            fileSize: file.size,
            totalFiles: this.files.length
          });
        }

        // Send file header
        this.dataChannel.send(JSON.stringify({
          action: 'FILE_HEADER',
          transferId: this.transferId,
          fileIndex: i,
          fileId,
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream'
        }));

        let fileOffset = 0;

        // Stream file using 2 MB block reads to minimize disk promise overhead
        while (fileOffset < file.size) {
          if (this.isCancelled) break;

          const blockEnd = Math.min(fileOffset + BLOCK_READ_SIZE, file.size);
          const blockSlice = file.slice(fileOffset, blockEnd);
          const blockBuffer = await blockSlice.arrayBuffer();

          let blockOffset = 0;
          while (blockOffset < blockBuffer.byteLength) {
            if (this.isCancelled) break;

            // Backpressure check
            if (this.dataChannel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
              await this.waitForBackpressure();
            }

            if (this.isCancelled) break;

            const chunkEnd = Math.min(blockOffset + CHUNK_SIZE, blockBuffer.byteLength);
            const chunk = blockBuffer.slice(blockOffset, chunkEnd);

            this.dataChannel.send(chunk);

            const chunkSize = chunk.byteLength;
            blockOffset += chunkSize;
            fileOffset += chunkSize;
            cumulativeTransferred += chunkSize;

            // Throttle UI progress update to ~12 FPS (every 80ms)
            const now = performance.now();
            if (now - lastProgressReportTime >= 80 || fileOffset >= file.size) {
              lastProgressReportTime = now;
              const stats = this.metrics.update(cumulativeTransferred);
              if (this.options.onProgress) {
                this.options.onProgress({
                  ...stats,
                  currentFileIndex: i,
                  currentFileName: file.name,
                  currentFileSize: file.size,
                  currentFileTransferred: fileOffset
                });
              }
            }
          }
        }

        if (this.isCancelled) break;

        // Signal file end and wait for receiver ack
        const ackPromise = new Promise((resolve) => {
          this.pendingFileAckResolver = resolve;
          setTimeout(resolve, 5000); // 5-second ack timeout safety
        });

        this.dataChannel.send(JSON.stringify({
          action: 'FILE_END',
          transferId: this.transferId,
          fileId,
          fileIndex: i
        }));

        await ackPromise;

        if (this.options.onFileComplete) {
          this.options.onFileComplete({
            fileIndex: i,
            fileName: file.name,
            fileSize: file.size
          });
        }
      }

      if (!this.isCancelled) {
        // Wait until all buffered bytes have completely drained out of the network buffer
        while (this.dataChannel && this.dataChannel.bufferedAmount > 0 && !this.isCancelled) {
          await new Promise(r => setTimeout(r, 40));
        }

        // Send transfer complete message
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
          this.dataChannel.send(JSON.stringify({
            action: 'TRANSFER_COMPLETE',
            transferId: this.transferId
          }));
        }

        // 400ms grace period to let receiver finish final assembly before socket termination
        await new Promise(r => setTimeout(r, 400));

        const finalStats = this.metrics.update(cumulativeTransferred);
        if (this.options.onComplete) {
          this.options.onComplete(finalStats);
        }
      }
    } catch (err) {
      console.error('[BeamDrop Sender] Transfer failed:', err);
      if (!this.isCancelled && this.options.onError) {
        this.options.onError(err);
      }
    } finally {
      await releaseWakeLock();
    }
  }

  cancel(reason = 'Transfer cancelled by sender.') {
    if (this.isCancelled) return;
    this.isCancelled = true;
    try {
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify({
          action: 'TRANSFER_CANCEL',
          reason
        }));
      }
    } catch (e) {}
    releaseWakeLock();
    if (this.options.onCancel) {
      this.options.onCancel(reason);
    }
  }
}

/**
 * File Transfer Receiver
 */
export class TransferReceiver {
  /**
   * @param {RTCDataChannel} dataChannel
   * @param {Object} options - callbacks { onStart, onProgress, onFileStart, onFileComplete, onComplete, onError, onCancel }
   * @param {FileSystemDirectoryHandle} dirHandle - optional directory handle
   */
  constructor(dataChannel, options = {}, dirHandle = null) {
    this.dataChannel = dataChannel;
    this.options = options;
    this.session = new FileReceiverSession(dirHandle);
    this.metrics = null;
    this.cumulativeReceived = 0;
    this.isCancelled = false;
    this.currentFileInfo = null;
    this.lastProgressReportTime = 0;
  }

  async handleMessage(eventOrData) {
    if (this.isCancelled) return;

    const data = eventOrData && eventOrData.data !== undefined ? eventOrData.data : eventOrData;

    // Binary chunk data (supports both ArrayBuffer and Blob)
    if (data instanceof ArrayBuffer || data instanceof Blob) {
      const chunk = data instanceof Blob ? await data.arrayBuffer() : data;
      await this.session.writeChunk(chunk);
      this.cumulativeReceived += chunk.byteLength;

      // Throttle receiver UI updates to every 80ms to prevent main thread layout thrashing
      const now = performance.now();
      if (now - this.lastProgressReportTime >= 80) {
        this.lastProgressReportTime = now;
        if (this.metrics) {
          const stats = this.metrics.update(this.cumulativeReceived);
          if (this.options.onProgress) {
            this.options.onProgress({
              ...stats,
              currentFileName: this.currentFileInfo ? this.currentFileInfo.name : '',
              currentFileSize: this.currentFileInfo ? this.currentFileInfo.size : 0
            });
          }
        }
      }
      return;
    }

    // JSON control message
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        await this.handleControlMessage(msg);
      } catch (err) {
        console.error('[BeamDrop Receiver] Error handling control message:', err);
      }
    }
  }

  async handleControlMessage(msg) {
    switch (msg.action) {
      case 'TRANSFER_START': {
        await requestWakeLock();
        this.metrics = new TransferMetrics(msg.totalSize);
        if (this.options.onStart) {
          this.options.onStart({
            totalFiles: msg.totalFiles,
            totalSize: msg.totalSize
          });
        }
        break;
      }

      case 'FILE_HEADER': {
        this.currentFileInfo = {
          id: msg.fileId,
          name: msg.name,
          size: msg.size,
          type: msg.type,
          index: msg.fileIndex
        };

        await this.session.startFile(this.currentFileInfo);

        if (this.options.onFileStart) {
          this.options.onFileStart(this.currentFileInfo);
        }
        break;
      }

      case 'FILE_END': {
        const finishedFile = await this.session.finishFile();

        // Send acknowledgment back to sender
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
          this.dataChannel.send(JSON.stringify({
            action: 'FILE_ACK',
            fileId: msg.fileId,
            fileIndex: msg.fileIndex
          }));
        }

        if (this.options.onFileComplete) {
          this.options.onFileComplete(finishedFile);
        }
        this.currentFileInfo = null;
        break;
      }

      case 'TRANSFER_COMPLETE': {
        await releaseWakeLock();
        const completedFiles = this.session.getCompletedFiles();
        const finalStats = this.metrics ? this.metrics.update(this.cumulativeReceived) : {};

        if (this.options.onComplete) {
          this.options.onComplete({
            ...finalStats,
            files: completedFiles
          });
        }
        break;
      }

      case 'TRANSFER_CANCEL': {
        this.isCancelled = true;
        await this.session.abort();
        await releaseWakeLock();
        if (this.options.onCancel) {
          this.options.onCancel(msg.reason || 'Transfer cancelled by sender.');
        }
        break;
      }
    }
  }

  async cancel(reason = 'Transfer cancelled by recipient.') {
    if (this.isCancelled) return;
    this.isCancelled = true;
    try {
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify({
          action: 'TRANSFER_CANCEL',
          reason
        }));
      }
    } catch (e) {}
    await this.session.abort();
    await releaseWakeLock();
    if (this.options.onCancel) {
      this.options.onCancel(reason);
    }
  }
}
