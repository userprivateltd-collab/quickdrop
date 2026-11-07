/**
 * BeamDrop Main Application Orchestrator
 * Integrates WebRTC signaling, file streaming, UI states, animations, and history.
 */

import {
  getDeviceProfile,
  saveDeviceProfile,
  getThemePreference,
  saveThemePreference,
  getSessionHistory,
  addHistoryEntry,
  clearSessionHistory
} from './storage.js';

import {
  formatBytes,
  formatSpeed,
  formatEta,
  triggerHaptic,
  playChime,
  getDeviceIconSvg,
  getFileBadgeIcon
} from './ui-utils.js';

// Immediately destroy any toast containers or notification overlays
function purgeNotificationStack() {
  document.querySelectorAll('#toast-container, .toast-container, .toast').forEach(el => el.remove());
}
purgeNotificationStack();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', purgeNotificationStack);
}

import { Capabilities, checkMemoryConstraint, requestSaveDirectory } from './fs-stream.js';
import { SignalingClient } from './signaling.js';
import { WebRTCConnection } from './webrtc.js';
import { TransferSender, TransferReceiver } from './transfer.js';
import { drawQRCode } from './qr-code.js';

// Application State
let profile = getDeviceProfile();
let signaling = new SignalingClient();
const peers = new Map(); // Map<peerId, { id, deviceName, deviceType, joinedAt }>
let selectedPeer = null;
let selectedFiles = [];
let activeRtc = null;
let activeTransfer = null; // { type: 'sender'|'receiver', engine, peerName, peerType, files, totalSize }
let pendingIncoming = null; // Incoming transfer request
let pendingOutgoing = null; // Outgoing transfer request
let networkInfo = { clientIp: '', isLan: true, localAddresses: [], port: 3000 };
let currentLanUrl = window.location.origin;

// Fast WebRTC signal buffer and watchdog
const earlySignalBuffer = new Map(); // peerId -> Array of early signals (offers/candidates)
let waitingTimeout = null;

async function flushEarlySignals(peerId) {
  if (!earlySignalBuffer.has(peerId) || !activeRtc) return;
  const queued = earlySignalBuffer.get(peerId);
  earlySignalBuffer.delete(peerId);
  for (const data of queued) {
    try {
      if (data.type === 'offer') await activeRtc.handleOffer(data.sdp);
      else if (data.type === 'answer') await activeRtc.handleAnswer(data.sdp);
      else if (data.type === 'ice-candidate') await activeRtc.handleCandidate(data.candidate);
    } catch (err) {
      console.warn('[BeamDrop] Error flushing early signal:', err);
    }
  }
}

// DOM Elements
const dom = {
  // Theme & Profile
  themeIconSun: document.getElementById('theme-icon-sun'),
  themeIconMoon: document.getElementById('theme-icon-moon'),
  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  btnProfileChip: document.getElementById('btn-profile-chip'),
  profileChipIcon: document.getElementById('profile-chip-icon'),
  profileChipName: document.getElementById('profile-chip-name'),
  userDeviceNode: document.getElementById('user-device-node'),
  userNodeAvatar: document.getElementById('user-node-avatar'),
  userNodeName: document.getElementById('user-node-name'),

  // PWA Install
  btnInstallPwa: document.getElementById('btn-install-pwa'),

  // Network Status
  networkStatusDot: document.getElementById('network-status-dot'),
  networkStatusText: document.getElementById('network-status-text'),
  networkRoomTag: document.getElementById('network-room-tag'),
  roomTagLabel: document.getElementById('room-tag-label'),

  // Radar & Peers
  discoveryEmptyState: document.getElementById('discovery-empty-state'),
  shareLanUrl: document.getElementById('share-lan-url'),
  btnCopyUrl: document.getElementById('btn-copy-url'),
  btnShowQr: document.getElementById('btn-show-qr'),
  btnEmptyRoom: document.getElementById('btn-empty-room'),
  peersSection: document.getElementById('peers-section'),
  peersGrid: document.getElementById('peers-grid'),
  peersCountLabel: document.getElementById('peers-count-label'),
  globalFileInput: document.getElementById('global-file-input'),
  dropzoneOverlay: document.getElementById('dropzone-overlay'),

  // Modals
  modalProfile: document.getElementById('modal-profile'),
  profileModalTitle: document.getElementById('profile-modal-title'),
  btnCloseProfile: document.getElementById('btn-close-profile'),
  profileCards: document.querySelectorAll('.device-select-card'),
  profileNameInput: document.getElementById('profile-name-input'),
  btnSaveProfile: document.getElementById('btn-save-profile'),
  detectedIosBadge: document.getElementById('detected-ios-badge'),
  detectedAndroidBadge: document.getElementById('detected-android-badge'),
  detectedWindowsBadge: document.getElementById('detected-windows-badge'),

  // Files Modal
  modalFiles: document.getElementById('modal-files'),
  sendTargetPeerName: document.getElementById('send-target-peer-name'),
  selectedFilesList: document.getElementById('selected-files-list'),
  selectedFilesSummary: document.getElementById('selected-files-summary'),
  btnAddMoreFiles: document.getElementById('btn-add-more-files'),
  btnCancelFiles: document.getElementById('btn-cancel-files'),
  btnCloseFiles: document.getElementById('btn-close-files'),
  btnConfirmSend: document.getElementById('btn-confirm-send'),

  // Incoming Request Modal
  modalRequest: document.getElementById('modal-request'),
  requestSenderIcon: document.getElementById('request-sender-icon'),
  requestSenderName: document.getElementById('request-sender-name'),
  requestSummaryLine: document.getElementById('request-summary-line'),
  requestFilesList: document.getElementById('request-files-list'),
  requestIosWarning: document.getElementById('request-ios-warning'),
  btnDeclineRequest: document.getElementById('btn-decline-request'),
  btnAcceptRequest: document.getElementById('btn-accept-request'),

  // Waiting Modal
  modalWaiting: document.getElementById('modal-waiting'),
  waitingHeadline: document.getElementById('waiting-headline'),
  waitingPeerSub: document.getElementById('waiting-peer-sub'),
  btnCancelWaiting: document.getElementById('btn-cancel-waiting'),

  // Active Transfer Modal
  modalTransfer: document.getElementById('modal-transfer'),
  transferHeadlineText: document.getElementById('transfer-headline-text'),
  txNodeSenderIcon: document.getElementById('tx-node-sender-icon'),
  txNodeSenderName: document.getElementById('tx-node-sender-name'),
  txNodeReceiverIcon: document.getElementById('tx-node-receiver-icon'),
  txNodeReceiverName: document.getElementById('tx-node-receiver-name'),
  txPercentage: document.getElementById('tx-percentage'),
  txCurrentFilename: document.getElementById('tx-current-filename'),
  txProgressFill: document.getElementById('tx-progress-fill'),
  txMetricSpeed: document.getElementById('tx-metric-speed'),
  txMetricTransferred: document.getElementById('tx-metric-transferred'),
  txMetricEta: document.getElementById('tx-metric-eta'),
  btnCancelTransfer: document.getElementById('btn-cancel-transfer'),

  // Complete Modal
  modalComplete: document.getElementById('modal-complete'),
  completeSummaryStats: document.getElementById('complete-summary-stats'),
  completeFilesContainer: document.getElementById('complete-files-container'),
  completeFilesList: document.getElementById('complete-files-list'),
  btnCompleteDone: document.getElementById('btn-complete-done'),

  // History Modal
  btnHistory: document.getElementById('btn-history'),
  historyBadge: document.getElementById('history-badge'),
  modalHistory: document.getElementById('modal-history'),
  btnCloseHistory: document.getElementById('btn-close-history'),
  btnDismissHistory: document.getElementById('btn-dismiss-history'),
  btnClearHistory: document.getElementById('btn-clear-history'),
  historyItemsContainer: document.getElementById('history-items-container'),

  // FAQ Modal
  btnInfo: document.getElementById('btn-info'),
  modalInfo: document.getElementById('modal-info'),
  btnCloseInfo: document.getElementById('btn-close-info'),
  btnDismissInfo: document.getElementById('btn-dismiss-info'),

  // QR Modal
  modalQr: document.getElementById('modal-qr'),
  qrCanvas: document.getElementById('qr-canvas'),
  qrUrlText: document.getElementById('qr-url-text'),
  btnCloseQr: document.getElementById('btn-close-qr'),
  btnCopyQrUrl: document.getElementById('btn-copy-qr-url'),
  btnDismissQr: document.getElementById('btn-dismiss-qr'),

  // Send Text Modal
  modalSendText: document.getElementById('modal-send-text'),
  sendTextTargetPeer: document.getElementById('send-text-target-peer'),
  sendTextInput: document.getElementById('send-text-input'),
  sendTextCharCount: document.getElementById('send-text-char-count'),
  btnPasteClipboard: document.getElementById('btn-paste-clipboard'),
  btnCloseSendText: document.getElementById('btn-close-send-text'),
  btnCancelSendText: document.getElementById('btn-cancel-send-text'),
  btnConfirmSendText: document.getElementById('btn-confirm-send-text'),

  // Receive Text Modal
  modalReceiveText: document.getElementById('modal-receive-text'),
  receiveTextSenderIcon: document.getElementById('receive-text-sender-icon'),
  receiveTextSenderName: document.getElementById('receive-text-sender-name'),
  receiveTextTime: document.getElementById('receive-text-time'),
  receiveTextBox: document.getElementById('receive-text-box'),
  receiveLinkAction: document.getElementById('receive-link-action'),
  receiveLinkBtn: document.getElementById('receive-link-btn'),
  btnCopyReceivedText: document.getElementById('btn-copy-received-text'),
  copyBtnLabel: document.getElementById('copy-btn-label'),
  btnCloseReceiveText: document.getElementById('btn-close-receive-text'),
  btnDismissReceiveText: document.getElementById('btn-dismiss-receive-text'),

  // Room / Pair Code Modal
  modalRoom: document.getElementById('modal-room'),
  roomCurrentDisplay: document.getElementById('room-current-display'),
  roomCodeInput: document.getElementById('room-code-input'),
  btnGenRoomCode: document.getElementById('btn-gen-room-code'),
  btnResetRoom: document.getElementById('btn-reset-room'),
  btnCloseRoom: document.getElementById('btn-close-room'),
  btnCancelRoom: document.getElementById('btn-cancel-room'),
  btnConfirmRoom: document.getElementById('btn-confirm-room')
};

/**
 * Initialize theme (light/dark)
 */
function initTheme() {
  const currentTheme = getThemePreference();
  document.documentElement.setAttribute('data-theme', currentTheme);
  updateThemeIcons(currentTheme);

  dom.btnThemeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const nextTheme = isDark ? 'light' : 'dark';
    saveThemePreference(nextTheme);
    updateThemeIcons(nextTheme);
  });
}

function updateThemeIcons(theme) {
  if (theme === 'dark') {
    dom.themeIconSun.style.display = 'block';
    dom.themeIconMoon.style.display = 'none';
  } else {
    dom.themeIconSun.style.display = 'none';
    dom.themeIconMoon.style.display = 'block';
  }
}

/**
 * Update User Header and Central Node Display
 */
function updateUserProfileUI() {
  const iconSvg = getDeviceIconSvg(profile.deviceType);
  dom.profileChipIcon.innerHTML = iconSvg;
  dom.profileChipName.textContent = profile.deviceName;
  dom.userNodeAvatar.innerHTML = iconSvg;
  dom.userNodeName.textContent = profile.deviceName;
}

/**
 * Onboarding & Profile Modal Handling
 */
let tempSelectedDevice = profile.deviceType;

function openProfileModal(isOnboarding = false) {
  tempSelectedDevice = profile.deviceType;
  dom.profileNameInput.value = profile.deviceName;
  dom.profileModalTitle.textContent = isOnboarding ? 'Welcome to sendit' : 'Edit Device Profile';
  dom.btnCloseProfile.style.display = isOnboarding ? 'none' : 'inline-flex';

  // Highlight detected badge
  dom.detectedIosBadge.style.display = profile.detectedType === 'ios' ? 'block' : 'none';
  dom.detectedAndroidBadge.style.display = profile.detectedType === 'android' ? 'block' : 'none';
  dom.detectedWindowsBadge.style.display = profile.detectedType === 'windows' ? 'block' : 'none';

  updateProfileCardsSelection(tempSelectedDevice);
  openModal(dom.modalProfile);
}

function updateProfileCardsSelection(type) {
  dom.profileCards.forEach(card => {
    if (card.dataset.device === type) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
}

dom.profileCards.forEach(card => {
  card.addEventListener('click', () => {
    tempSelectedDevice = card.dataset.device;
    updateProfileCardsSelection(tempSelectedDevice);
  });
});

dom.btnSaveProfile.addEventListener('click', () => {
  const name = dom.profileNameInput.value.trim();
  if (!name) {
    dom.profileNameInput.focus();
    return;
  }

  profile.deviceType = tempSelectedDevice;
  profile.deviceName = name;
  saveDeviceProfile(profile.deviceType, profile.deviceName);
  updateUserProfileUI();
  closeModal(dom.modalProfile);

  // Update signaling
  signaling.updateProfile(profile);
});

dom.btnCloseProfile.addEventListener('click', () => closeModal(dom.modalProfile));
dom.btnProfileChip.addEventListener('click', () => openProfileModal(false));
dom.userDeviceNode.addEventListener('click', () => openProfileModal(false));

/**
 * Fetch Network Info & Local IP for easy sharing
 */
async function fetchNetworkInfo() {
  try {
    const res = await fetch('/api/info');
    if (res.ok) {
      networkInfo = await res.json();
      if (networkInfo.localAddresses && networkInfo.localAddresses.length > 0) {
        currentLanUrl = `http://${networkInfo.localAddresses[0].address}:${networkInfo.port}`;
      } else {
        currentLanUrl = window.location.origin;
      }
      dom.shareLanUrl.textContent = currentLanUrl;
      dom.qrUrlText.textContent = currentLanUrl;
    }
  } catch (e) {
    dom.shareLanUrl.textContent = window.location.origin;
    dom.qrUrlText.textContent = window.location.origin;
  }
}

/**
 * Modal Helpers
 */
function openModal(modal) {
  modal.classList.add('open');
}

function closeModal(modal) {
  modal.classList.remove('open');
}

// Copy URL handler
dom.btnCopyUrl.addEventListener('click', () => {
  navigator.clipboard.writeText(currentLanUrl).then(() => {
    const orig = dom.btnCopyUrl.innerHTML;
    dom.btnCopyUrl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:-1px; margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Copied!`;
    setTimeout(() => { dom.btnCopyUrl.innerHTML = orig; }, 2000);
  }).catch(() => {
    prompt('Copy link:', currentLanUrl);
  });
});

// Show QR Code Modal
dom.btnShowQr.addEventListener('click', () => {
  drawQRCode(dom.qrCanvas, currentLanUrl);
  openModal(dom.modalQr);
});

dom.btnCloseQr.addEventListener('click', () => closeModal(dom.modalQr));
dom.btnDismissQr.addEventListener('click', () => closeModal(dom.modalQr));
dom.btnCopyQrUrl.addEventListener('click', () => {
  navigator.clipboard.writeText(currentLanUrl).then(() => {
    const orig = dom.btnCopyQrUrl.innerHTML;
    dom.btnCopyQrUrl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:-1px; margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Copied!`;
    setTimeout(() => { dom.btnCopyQrUrl.innerHTML = orig; }, 2000);
  });
});

/**
 * Render Peer Cards on Radar Screen
 */
function renderPeers() {
  dom.peersGrid.innerHTML = '';
  const peerList = Array.from(peers.values());

  if (peerList.length === 0) {
    dom.discoveryEmptyState.style.display = 'flex';
    dom.peersSection.style.display = 'none';
    dom.peersCountLabel.textContent = '0 available';
    return;
  }

  dom.discoveryEmptyState.style.display = 'none';
  dom.peersSection.style.display = 'block';
  dom.peersCountLabel.textContent = `${peerList.length} available`;

  peerList.forEach(peer => {
    const card = document.createElement('div');
    card.className = 'peer-card animate-scale-up';
    card.dataset.peerId = peer.id;

    card.innerHTML = `
      <div class="peer-card-icon-wrap">
        ${getDeviceIconSvg(peer.deviceType)}
      </div>
      <div class="peer-card-info">
        <div class="peer-card-name" title="${peer.deviceName}">${peer.deviceName}</div>
        <div class="peer-card-type">${(peer.deviceType || 'Device').toUpperCase()} • Ready</div>
      </div>
      <div class="peer-card-actions">
        <button class="btn btn-primary btn-sm btn-send-files" title="Send files to this device">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Files
        </button>
        <button class="btn btn-secondary btn-sm btn-send-text" title="Send text, link, or note directly">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Text
        </button>
      </div>
    `;

    // Tap "Files" button
    const btnFiles = card.querySelector('.btn-send-files');
    if (btnFiles) {
      btnFiles.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerHaptic('tap');
        initiateSendFilesToPeer(peer);
      });
    }

    // Tap "Text" button
    const btnText = card.querySelector('.btn-send-text');
    if (btnText) {
      btnText.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerHaptic('tap');
        initiateSendTextToPeer(peer);
      });
    }

    // Tap card outside buttons defaults to files
    card.addEventListener('click', () => {
      triggerHaptic('tap');
      initiateSendFilesToPeer(peer);
    });

    // Drag-over onto individual card
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        selectedPeer = peer;
        selectedFiles = Array.from(e.dataTransfer.files);
        openSelectedFilesModal();
      }
    });

    dom.peersGrid.appendChild(card);
  });
}

/**
 * File Selection & Preview Flow
 */
function initiateSendFilesToPeer(peer) {
  selectedPeer = peer;
  if (dom.globalFileInput) {
    dom.globalFileInput.value = ''; // Always clear previous file selection so re-selecting triggers reliably
    dom.globalFileInput.click();
  }
}

dom.globalFileInput.addEventListener('change', () => {
  if (dom.globalFileInput.files.length > 0) {
    selectedFiles = Array.from(dom.globalFileInput.files);
    dom.globalFileInput.value = '';
    openSelectedFilesModal();
  }
});

dom.btnAddMoreFiles.addEventListener('click', () => {
  const tempInput = document.createElement('input');
  tempInput.type = 'file';
  tempInput.multiple = true;
  tempInput.onchange = () => {
    if (tempInput.files.length > 0) {
      selectedFiles = selectedFiles.concat(Array.from(tempInput.files));
      renderSelectedFilesList();
    }
  };
  tempInput.click();
});

function openSelectedFilesModal() {
  if (!selectedPeer || selectedFiles.length === 0) return;
  dom.sendTargetPeerName.textContent = selectedPeer.deviceName;
  renderSelectedFilesList();
  openModal(dom.modalFiles);
}

function renderSelectedFilesList() {
  dom.selectedFilesList.innerHTML = '';
  let totalBytes = 0;

  selectedFiles.forEach((file, index) => {
    totalBytes += file.size;
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-item-left">
        <div class="file-icon">${getFileBadgeIcon(file.name, file.type)}</div>
        <div class="file-info">
          <div class="file-name" title="${file.name}">${file.name}</div>
          <div class="file-size">${formatBytes(file.size)}</div>
        </div>
      </div>
      <button class="file-remove-btn" title="Remove file" data-index="${index}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;

    item.querySelector('.file-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      selectedFiles.splice(index, 1);
      if (selectedFiles.length === 0) {
        closeModal(dom.modalFiles);
      } else {
        renderSelectedFilesList();
      }
    });

    dom.selectedFilesList.appendChild(item);
  });

  dom.selectedFilesSummary.textContent = `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} • ${formatBytes(totalBytes)}`;
}

dom.btnCancelFiles.addEventListener('click', () => closeModal(dom.modalFiles));
dom.btnCloseFiles.addEventListener('click', () => closeModal(dom.modalFiles));

/**
 * Confirm Send Files -> Send Transfer Request
 */
dom.btnConfirmSend.addEventListener('click', () => {
  if (!selectedPeer || selectedFiles.length === 0) return;

  const totalSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
  const transferId = 'tx_' + Date.now();

  const fileDescriptors = selectedFiles.map((f, i) => ({
    id: `f_${i}`,
    name: f.name,
    size: f.size,
    type: f.type || 'application/octet-stream'
  }));

  pendingOutgoing = {
    transferId,
    targetPeer: selectedPeer,
    files: selectedFiles,
    totalSize
  };

  // Send transfer-request signal to recipient peer
  signaling.sendSignal(selectedPeer.id, {
    type: 'transfer-request',
    transferId,
    files: fileDescriptors,
    totalSize,
    senderName: profile.deviceName,
    senderType: profile.deviceType
  });

  closeModal(dom.modalFiles);

  // Open waiting modal
  dom.waitingHeadline.textContent = `Waiting for ${selectedPeer.deviceName}...`;
  dom.waitingPeerSub.textContent = `Sent request for ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} (${formatBytes(totalSize)}).`;
  openModal(dom.modalWaiting);

  // 45-second timeout watchdog for recipient response
  clearTimeout(waitingTimeout);
  waitingTimeout = setTimeout(() => {
    if (pendingOutgoing && pendingOutgoing.transferId === transferId) {
      dom.waitingHeadline.textContent = `No response from ${selectedPeer.deviceName}`;
      dom.waitingPeerSub.textContent = 'Make sure the recipient is on the same Wi-Fi with sendit open on their screen.';
    }
  }, 45000);
});

dom.btnCancelWaiting.addEventListener('click', () => {
  clearTimeout(waitingTimeout);
  if (pendingOutgoing) {
    signaling.sendSignal(pendingOutgoing.targetPeer.id, {
      type: 'transfer-cancel',
      transferId: pendingOutgoing.transferId,
      reason: 'Request cancelled by sender.'
    });
    pendingOutgoing = null;
  }
  closeModal(dom.modalWaiting);
});

/**
 * Direct P2P Text / Note / Link Sharing
 */
function initiateSendTextToPeer(peer) {
  selectedPeer = peer;
  if (dom.sendTextTargetPeer) dom.sendTextTargetPeer.textContent = peer.deviceName;
  if (dom.sendTextInput) {
    dom.sendTextInput.value = '';
    updateTextCharCount();
  }
  openModal(dom.modalSendText);
  setTimeout(() => {
    if (dom.sendTextInput) dom.sendTextInput.focus();
  }, 120);
}

function updateTextCharCount() {
  if (!dom.sendTextInput || !dom.sendTextCharCount) return;
  const count = dom.sendTextInput.value.length;
  dom.sendTextCharCount.textContent = `${count} character${count === 1 ? '' : 's'}`;
}

if (dom.sendTextInput) {
  dom.sendTextInput.addEventListener('input', updateTextCharCount);
}

if (dom.btnPasteClipboard) {
  dom.btnPasteClipboard.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const clipText = await navigator.clipboard.readText();
        if (clipText) {
          dom.sendTextInput.value = clipText;
          updateTextCharCount();
          dom.sendTextInput.focus();
        }
      }
    } catch (err) {
      console.warn('Clipboard access not allowed or unavailable:', err);
    }
  });
}

if (dom.btnCloseSendText) dom.btnCloseSendText.addEventListener('click', () => closeModal(dom.modalSendText));
if (dom.btnCancelSendText) dom.btnCancelSendText.addEventListener('click', () => closeModal(dom.modalSendText));

if (dom.btnConfirmSendText) {
  dom.btnConfirmSendText.addEventListener('click', () => {
    if (!selectedPeer) return;
    const text = (dom.sendTextInput.value || '').trim();
    if (!text) {
      dom.sendTextInput.focus();
      return;
    }

    // Send direct text message signal
    signaling.sendSignal(selectedPeer.id, {
      type: 'text-message',
      text: text,
      timestamp: Date.now()
    });

    // Record sent note in session history
    addHistoryEntry({
      direction: 'sent',
      peerName: selectedPeer.deviceName,
      peerType: selectedPeer.deviceType,
      isText: true,
      textContent: text,
      status: 'completed'
    });
    updateHistoryBadge();

    playChime('success');
    triggerHaptic('tap');
    closeModal(dom.modalSendText);
  });
}

/**
 * Handle Incoming Text Note / Link
 */
function handleIncomingTextMessage(fromPeerId, fromName, fromType, data) {
  playChime('message');
  triggerHaptic('tap');

  const text = data.text || '';
  const timestamp = data.timestamp || Date.now();

  // Record in session history
  addHistoryEntry({
    direction: 'received',
    peerName: fromName,
    peerType: fromType,
    isText: true,
    textContent: text,
    status: 'completed'
  });
  updateHistoryBadge();

  // Populate Receive Text Modal
  if (dom.receiveTextSenderIcon) dom.receiveTextSenderIcon.innerHTML = getDeviceIconSvg(fromType);
  if (dom.receiveTextSenderName) dom.receiveTextSenderName.textContent = fromName;
  if (dom.receiveTextTime) {
    dom.receiveTextTime.textContent = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (dom.receiveTextBox) dom.receiveTextBox.textContent = text;

  // Auto-detect URL
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/i);
  if (urlMatch && dom.receiveLinkAction && dom.receiveLinkBtn) {
    dom.receiveLinkAction.style.display = 'block';
    dom.receiveLinkBtn.href = urlMatch[0];
  } else if (dom.receiveLinkAction) {
    dom.receiveLinkAction.style.display = 'none';
  }

  // Reset copy button label
  if (dom.copyBtnLabel) dom.copyBtnLabel.textContent = 'Copy Text';

  openModal(dom.modalReceiveText);
}

if (dom.btnCopyReceivedText) {
  dom.btnCopyReceivedText.addEventListener('click', () => {
    const text = (dom.receiveTextBox ? dom.receiveTextBox.textContent : '') || '';
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
      triggerHaptic('tap');
      if (dom.copyBtnLabel) dom.copyBtnLabel.textContent = 'Copied!';
      setTimeout(() => {
        if (dom.copyBtnLabel) dom.copyBtnLabel.textContent = 'Copy Text';
      }, 2000);
    }).catch(() => {
      prompt('Copy text:', text);
    });
  });
}

if (dom.btnCloseReceiveText) dom.btnCloseReceiveText.addEventListener('click', () => closeModal(dom.modalReceiveText));
if (dom.btnDismissReceiveText) dom.btnDismissReceiveText.addEventListener('click', () => closeModal(dom.modalReceiveText));

/**
 * Network Room & Pair Code Switcher
 */
function openRoomModal() {
  const currentParams = new URLSearchParams(window.location.search);
  const explicitRoom = currentParams.get('room');

  if (explicitRoom) {
    if (dom.roomCurrentDisplay) dom.roomCurrentDisplay.textContent = `Pair Code: ${explicitRoom.toUpperCase()}`;
    if (dom.roomCodeInput) dom.roomCodeInput.value = explicitRoom.toUpperCase();
  } else {
    const activeRoomName = signaling.roomId || 'lan-network';
    if (dom.roomCurrentDisplay) dom.roomCurrentDisplay.textContent = `Local WiFi (${activeRoomName})`;
    if (dom.roomCodeInput) dom.roomCodeInput.value = '';
  }

  openModal(dom.modalRoom);
  setTimeout(() => {
    if (dom.roomCodeInput) dom.roomCodeInput.focus();
  }, 120);
}

if (dom.networkRoomTag) dom.networkRoomTag.addEventListener('click', openRoomModal);
if (dom.btnEmptyRoom) dom.btnEmptyRoom.addEventListener('click', openRoomModal);

if (dom.btnGenRoomCode) {
  dom.btnGenRoomCode.addEventListener('click', () => {
    const randomCode = Math.floor(1000 + Math.random() * 9000).toString();
    if (dom.roomCodeInput) {
      dom.roomCodeInput.value = randomCode;
      dom.roomCodeInput.focus();
    }
  });
}

if (dom.btnResetRoom) {
  dom.btnResetRoom.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.location.href = url.toString();
  });
}

if (dom.btnConfirmRoom) {
  dom.btnConfirmRoom.addEventListener('click', () => {
    const code = (dom.roomCodeInput ? dom.roomCodeInput.value : '').trim().toLowerCase();
    if (!code) {
      if (dom.roomCodeInput) dom.roomCodeInput.focus();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    window.location.href = url.toString();
  });
}

if (dom.btnCloseRoom) dom.btnCloseRoom.addEventListener('click', () => closeModal(dom.modalRoom));
if (dom.btnCancelRoom) dom.btnCancelRoom.addEventListener('click', () => closeModal(dom.modalRoom));

/**
 * PWA Native 1-Click Install Prompt
 */
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (dom.btnInstallPwa) {
    dom.btnInstallPwa.style.display = 'inline-flex';
  }
});

if (dom.btnInstallPwa) {
  dom.btnInstallPwa.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        dom.btnInstallPwa.style.display = 'none';
      }
      deferredInstallPrompt = null;
    }
  });
}

window.addEventListener('appinstalled', () => {
  if (dom.btnInstallPwa) {
    dom.btnInstallPwa.style.display = 'none';
  }
  deferredInstallPrompt = null;
});

/**
 * Incoming Request Handling (Receiver Side)
 */
function handleIncomingTransferRequest(fromPeerId, fromName, fromType, data) {
  pendingIncoming = {
    fromPeerId,
    fromName: fromName || 'Nearby Device',
    fromType: fromType || 'desktop',
    transferId: data.transferId,
    files: data.files || [],
    totalSize: data.totalSize || 0
  };

  playChime('request');
  triggerHaptic('warning');

  dom.requestSenderIcon.innerHTML = getDeviceIconSvg(pendingIncoming.fromType);
  dom.requestSenderName.textContent = pendingIncoming.fromName;
  dom.requestSummaryLine.textContent = `wants to send you ${pendingIncoming.files.length} file${pendingIncoming.files.length > 1 ? 's' : ''} (${formatBytes(pendingIncoming.totalSize)})`;

  // Check iOS Safari memory limit
  const memCheck = checkMemoryConstraint(pendingIncoming.totalSize);
  dom.requestIosWarning.style.display = memCheck.warning ? 'block' : 'none';

  // Render incoming files preview list
  dom.requestFilesList.innerHTML = '';
  pendingIncoming.files.forEach(f => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-item-left">
        <div class="file-icon">${getFileBadgeIcon(f.name, f.type)}</div>
        <div class="file-info">
          <div class="file-name" title="${f.name}">${f.name}</div>
          <div class="file-size">${formatBytes(f.size)}</div>
        </div>
      </div>
    `;
    dom.requestFilesList.appendChild(item);
  });

  openModal(dom.modalRequest);
}

dom.btnDeclineRequest.addEventListener('click', () => {
  if (pendingIncoming) {
    signaling.sendSignal(pendingIncoming.fromPeerId, {
      type: 'transfer-response',
      transferId: pendingIncoming.transferId,
      accepted: false,
      reason: 'Declined by recipient.'
    });
    pendingIncoming = null;
  }
  closeModal(dom.modalRequest);
});

dom.btnAcceptRequest.addEventListener('click', () => {
  if (!pendingIncoming) return;
  const req = pendingIncoming;
  pendingIncoming = null;
  closeModal(dom.modalRequest);

  // Instant response - zero blocking OS folder dialogs
  setupReceiverWebRTC(req, null);

  // Send accepted signal to sender immediately
  signaling.sendSignal(req.fromPeerId, {
    type: 'transfer-response',
    transferId: req.transferId,
    accepted: true
  });
});

/**
 * Setup Receiver WebRTC & Transfer UI
 */
function setupReceiverWebRTC(req, dirHandle) {
  cleanupActiveTransfer();

  activeRtc = new WebRTCConnection(req.fromPeerId, signaling.iceServers, (targetId, signalData) => {
    signaling.sendSignal(targetId, signalData);
  });

  activeRtc.onStatusText = (txt) => {
    if (dom.txCurrentFilename) dom.txCurrentFilename.textContent = txt;
  };

  // Setup UI elements
  dom.transferHeadlineText.textContent = 'Receiving Files...';
  dom.txNodeSenderIcon.innerHTML = getDeviceIconSvg(req.fromType);
  dom.txNodeSenderName.textContent = req.fromName;
  dom.txNodeReceiverIcon.innerHTML = getDeviceIconSvg(profile.deviceType);
  dom.txNodeReceiverName.textContent = profile.deviceName;
  resetTransferUI(req.totalSize);
  openModal(dom.modalTransfer);

  // Flush any early queued signals from this peer
  flushEarlySignals(req.fromPeerId);

  activeRtc.onChannelOpen = (channel) => {
    const receiverEngine = new TransferReceiver(channel, {
      onStart: (info) => {
        dom.txCurrentFilename.textContent = `Receiving ${info.totalFiles} files...`;
      },
      onProgress: (stats) => {
        updateTransferUIProgress(stats);
      },
      onFileStart: (file) => {
        dom.txCurrentFilename.textContent = `Receiving ${file.name}...`;
      },
      onFileComplete: (file) => {},
      onComplete: (summary) => {
        handleTransferComplete({
          direction: 'received',
          peerName: req.fromName,
          peerType: req.fromType,
          totalFiles: req.files.length,
          totalSize: req.totalSize,
          elapsedSeconds: summary.elapsedSeconds,
          avgSpeed: summary.avgSpeed,
          files: summary.files
        });
      },
      onCancel: (reason) => {
        handleTransferCancelled(reason, 'received', req.fromName, req.fromType, req.files.length, req.totalSize);
      },
      onError: (err) => {
        console.error('Transfer failed:', err);
        closeModal(dom.modalTransfer);
        cleanupActiveTransfer();
      }
    }, dirHandle);

    activeTransfer = {
      type: 'receiver',
      engine: receiverEngine,
      peerName: req.fromName,
      peerType: req.fromType
    };

    channel.onmessage = (e) => receiverEngine.handleMessage(e);
  };
}

/**
 * Setup Sender WebRTC & Transfer UI
 */
function setupSenderWebRTC(pending) {
  cleanupActiveTransfer();

  activeRtc = new WebRTCConnection(pending.targetPeer.id, signaling.iceServers, (targetId, signalData) => {
    signaling.sendSignal(targetId, signalData);
  });

  activeRtc.onStatusText = (txt) => {
    if (dom.txCurrentFilename) dom.txCurrentFilename.textContent = txt;
  };

  // Setup UI elements
  dom.transferHeadlineText.textContent = 'Sending Files...';
  dom.txNodeSenderIcon.innerHTML = getDeviceIconSvg(profile.deviceType);
  dom.txNodeSenderName.textContent = profile.deviceName;
  dom.txNodeReceiverIcon.innerHTML = getDeviceIconSvg(pending.targetPeer.deviceType);
  dom.txNodeReceiverName.textContent = pending.targetPeer.deviceName;
  resetTransferUI(pending.totalSize);
  openModal(dom.modalTransfer);

  // Flush any early queued signals from this peer
  flushEarlySignals(pending.targetPeer.id);

  activeRtc.onChannelOpen = async (channel) => {
    const senderEngine = new TransferSender(channel, pending.files, {
      onProgress: (stats) => {
        updateTransferUIProgress(stats);
      },
      onFileStart: (info) => {
        dom.txCurrentFilename.textContent = `Sending ${info.fileName} (${info.fileIndex + 1}/${info.totalFiles})...`;
      },
      onFileComplete: (info) => {},
      onComplete: (summary) => {
        handleTransferComplete({
          direction: 'sent',
          peerName: pending.targetPeer.deviceName,
          peerType: pending.targetPeer.deviceType,
          totalFiles: pending.files.length,
          totalSize: pending.totalSize,
          elapsedSeconds: summary.elapsedSeconds,
          avgSpeed: summary.avgSpeed,
          files: pending.files.map(f => ({ name: f.name, size: f.size, type: f.type }))
        });
      },
      onCancel: (reason) => {
        handleTransferCancelled(reason, 'sent', pending.targetPeer.deviceName, pending.targetPeer.deviceType, pending.files.length, pending.totalSize);
      },
      onError: (err) => {
        console.error('Transfer error:', err);
        closeModal(dom.modalTransfer);
        cleanupActiveTransfer();
      }
    });

    activeTransfer = {
      type: 'sender',
      engine: senderEngine,
      peerName: pending.targetPeer.deviceName,
      peerType: pending.targetPeer.deviceType
    };

    channel.onmessage = (e) => senderEngine.handleMessage(e.data);

    // Start transmission!
    await senderEngine.start();
  };

  // Create offer to recipient
  activeRtc.createOffer().catch(err => {
    console.error('Failed to establish WebRTC connection:', err);
    closeModal(dom.modalTransfer);
    cleanupActiveTransfer();
  });
}

/**
 * Reset & Update Transfer Screen UI
 */
function resetTransferUI(totalBytes) {
  dom.txPercentage.textContent = '0%';
  dom.txProgressFill.style.width = '0%';
  dom.txMetricSpeed.textContent = '0 KB/s';
  dom.txMetricTransferred.textContent = `0 B / ${formatBytes(totalBytes)}`;
  dom.txMetricEta.textContent = '--:--';
  dom.txCurrentFilename.textContent = 'Connecting data channel...';
}

function updateTransferUIProgress(stats) {
  dom.txPercentage.textContent = stats.percent.toFixed(1) + '%';
  dom.txProgressFill.style.width = stats.percent + '%';
  dom.txMetricSpeed.textContent = formatSpeed(stats.speed);
  dom.txMetricTransferred.textContent = `${formatBytes(stats.transferredBytes)} / ${formatBytes(stats.totalBytes)}`;
  dom.txMetricEta.textContent = formatEta(stats.etaSeconds);
}

// Cancel Active Transfer Button
dom.btnCancelTransfer.addEventListener('click', () => {
  if (activeTransfer && activeTransfer.engine) {
    activeTransfer.engine.cancel('Transfer cancelled by user.');
  }
});

/**
 * Handle Transfer Completion
 */
function handleTransferComplete(data) {
  playChime('success');
  triggerHaptic('success');
  closeModal(dom.modalTransfer);

  // Add real history record
  addHistoryEntry({
    direction: data.direction,
    peerName: data.peerName,
    peerType: data.peerType,
    filesCount: data.totalFiles,
    totalSize: data.totalSize,
    status: 'completed',
    files: data.files
  });
  updateHistoryBadge();

  // Populate Complete Modal
  dom.completeSummaryStats.textContent = `${data.totalFiles} file${data.totalFiles > 1 ? 's' : ''} (${formatBytes(data.totalSize)}) transferred in ${data.elapsedSeconds.toFixed(1)}s at avg ${formatSpeed(data.avgSpeed)}`;

  if (data.direction === 'received' && data.files && data.files.length > 0) {
    dom.completeFilesContainer.style.display = 'block';
    dom.completeFilesList.innerHTML = '';

    // Add 1-click Download All button if multiple files
    const downloadables = data.files.filter(f => f.url);
    if (downloadables.length > 1) {
      const downloadAllWrap = document.createElement('div');
      downloadAllWrap.style.marginBottom = '12px';
      downloadAllWrap.innerHTML = `
        <button id="btn-download-all" class="btn btn-primary btn-sm" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download All (${downloadables.length} files)
        </button>
      `;
      downloadAllWrap.querySelector('#btn-download-all').onclick = () => {
        downloadables.forEach((f, idx) => {
          setTimeout(() => {
            const a = document.createElement('a');
            a.href = f.url;
            a.download = f.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
          }, idx * 250);
        });
      };
      dom.completeFilesList.appendChild(downloadAllWrap);
    }

    data.files.forEach(f => {
      const item = document.createElement('div');
      item.className = 'file-item';

      let actionHtml = '';
      if (f.savedToDisk) {
        actionHtml = `<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.76rem; color: var(--color-success); font-weight: 600;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Saved to Folder</span>`;
      } else if (f.url) {
        actionHtml = `
          <div style="display: flex; gap: 6px;">
            <a href="${f.url}" download="${f.name}" class="btn btn-primary btn-sm" style="text-decoration: none;">Download</a>
            <a href="${f.url}" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration: none;">Open</a>
          </div>
        `;
      }

      item.innerHTML = `
        <div class="file-item-left">
          <div class="file-icon">${getFileBadgeIcon(f.name, f.type)}</div>
          <div class="file-info">
            <div class="file-name" title="${f.name}">${f.name}</div>
            <div class="file-size">${formatBytes(f.size)}</div>
          </div>
        </div>
        ${actionHtml}
      `;
      dom.completeFilesList.appendChild(item);
    });
  } else {
    dom.completeFilesContainer.style.display = 'none';
  }

  openModal(dom.modalComplete);
  cleanupActiveTransfer();
}

/**
 * Handle Transfer Cancelled
 */
function handleTransferCancelled(reason, direction, peerName, peerType, totalFiles, totalSize) {
  closeModal(dom.modalTransfer);

  addHistoryEntry({
    direction,
    peerName,
    peerType,
    filesCount: totalFiles,
    totalSize,
    status: 'cancelled',
    files: []
  });
  updateHistoryBadge();

  cleanupActiveTransfer();
}

function cleanupActiveTransfer() {
  if (activeRtc) {
    activeRtc.close();
    activeRtc = null;
  }
  activeTransfer = null;
}

dom.btnCompleteDone.addEventListener('click', () => {
  closeModal(dom.modalComplete);
});

/**
 * Signaling Event Listeners
 */
signaling.onStatusChange = (status) => {
  if (status.connected) {
    dom.networkStatusDot.className = 'status-dot connected';
    dom.networkStatusText.textContent = 'WiFi: Connected';
  } else if (status.reconnecting) {
    dom.networkStatusDot.className = 'status-dot';
    dom.networkStatusText.textContent = 'Reconnecting...';
  } else {
    dom.networkStatusDot.className = 'status-dot disconnected';
    dom.networkStatusText.textContent = 'Offline';
  }
};

signaling.onWelcome = (msg) => {
  const currentParams = new URLSearchParams(window.location.search);
  const explicitRoom = currentParams.get('room');
  if (explicitRoom) {
    if (dom.roomTagLabel) dom.roomTagLabel.textContent = `Pair: ${explicitRoom.toUpperCase()}`;
  } else {
    if (dom.roomTagLabel) dom.roomTagLabel.textContent = `Room: ${msg.roomId}`;
  }
};

signaling.onPeerList = (peerList) => {
  peers.clear();
  peerList.forEach(p => peers.set(p.id, p));
  renderPeers();
};

signaling.onPeerJoined = (peer) => {
  peers.set(peer.id, peer);
  renderPeers();
};

signaling.onPeerLeft = (peerId) => {
  const leftPeer = peers.get(peerId);
  peers.delete(peerId);
  renderPeers();

  // If active transfer was with this peer, terminate cleanly
  if (activeTransfer && activeTransfer.peerName === (leftPeer ? leftPeer.deviceName : '')) {
    if (activeTransfer.engine) {
      activeTransfer.engine.cancel('Peer disconnected from network.');
    }
  }

  // If waiting for this peer, cancel
  if (pendingOutgoing && pendingOutgoing.targetPeer.id === peerId) {
    closeModal(dom.modalWaiting);
    pendingOutgoing = null;
  }
};

signaling.onPeerUpdated = (peer) => {
  peers.set(peer.id, peer);
  renderPeers();
};

signaling.onSignal = async (fromPeerId, fromName, fromType, data) => {
  // 0. Direct Text / Link Message
  if (data.type === 'text-message') {
    handleIncomingTextMessage(fromPeerId, fromName, fromType, data);
    return;
  }

  // 1. Transfer request
  if (data.type === 'transfer-request') {
    handleIncomingTransferRequest(fromPeerId, fromName, fromType, data);
    return;
  }

  // 2. Transfer response (accept/decline)
  if (data.type === 'transfer-response') {
    if (pendingOutgoing && pendingOutgoing.transferId === data.transferId) {
      clearTimeout(waitingTimeout);
      if (data.accepted) {
        closeModal(dom.modalWaiting);
        setupSenderWebRTC(pendingOutgoing);
      } else {
        dom.waitingHeadline.textContent = `${pendingOutgoing.targetPeer.deviceName} declined.`;
        dom.waitingPeerSub.textContent = data.reason || 'Transfer request was rejected.';
        setTimeout(() => closeModal(dom.modalWaiting), 2500);
      }
      pendingOutgoing = null;
    }
    return;
  }

  // 3. Transfer cancel
  if (data.type === 'transfer-cancel') {
    if (pendingIncoming && pendingIncoming.transferId === data.transferId) {
      closeModal(dom.modalRequest);
      pendingIncoming = null;
    }
    return;
  }

  // 4. WebRTC Signaling relay (offer, answer, ice-candidate)
  if (activeRtc && activeRtc.targetPeerId === fromPeerId) {
    if (data.type === 'offer') {
      await activeRtc.handleOffer(data.sdp);
    } else if (data.type === 'answer') {
      await activeRtc.handleAnswer(data.sdp);
    } else if (data.type === 'ice-candidate') {
      await activeRtc.handleCandidate(data.candidate);
    }
  } else {
    // Buffer early signals so rapid offers/candidates are never dropped
    if (!earlySignalBuffer.has(fromPeerId)) {
      earlySignalBuffer.set(fromPeerId, []);
    }
    earlySignalBuffer.get(fromPeerId).push(data);
  }
};

signaling.onSignalError = (msg) => {
  console.warn('[BeamDrop Signaling]', msg.message);
};

/**
 * Drag and Drop Support
 */
let dragCounter = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dom.dropzoneOverlay.classList.add('active');
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dom.dropzoneOverlay.classList.remove('active');
  }
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dom.dropzoneOverlay.classList.remove('active');

  if (e.dataTransfer && e.dataTransfer.files.length > 0) {
    const droppedFiles = Array.from(e.dataTransfer.files);
    const peerList = Array.from(peers.values());

    if (peerList.length === 0) {
      return;
    }

    if (peerList.length === 1) {
      selectedPeer = peerList[0];
      selectedFiles = droppedFiles;
      openSelectedFilesModal();
    } else {
      // Pick first peer
      selectedPeer = peerList[0];
      selectedFiles = droppedFiles;
      openSelectedFilesModal();
    }
  }
});

/**
 * History Modal Handling
 */
function updateHistoryBadge() {
  const history = getSessionHistory();
  if (history.length > 0) {
    dom.historyBadge.style.display = 'flex';
    dom.historyBadge.textContent = history.length;
  } else {
    dom.historyBadge.style.display = 'none';
  }
}

function renderHistoryList() {
  const history = getSessionHistory();
  dom.historyItemsContainer.innerHTML = '';

  if (history.length === 0) {
    dom.historyItemsContainer.innerHTML = `
      <div style="text-align: center; padding: 32px 16px; color: var(--text-tertiary);">
        No transfers in this session yet.
      </div>
    `;
    return;
  }

  history.forEach(item => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const dateStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (item.isText) {
      const snippet = (item.textContent || '').slice(0, 65);
      el.innerHTML = `
        <div class="history-item-left">
          <span class="history-badge ${item.direction}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline-block; vertical-align:-1px; margin-right:2px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            ${item.direction}
          </span>
          <div>
            <div class="history-title">${item.peerName}</div>
            <div class="history-time">Note • ${dateStr}</div>
            <div class="history-text-snippet" title="${item.textContent || ''}">${snippet}${item.textContent && item.textContent.length > 65 ? '...' : ''}</div>
          </div>
        </div>
        <div class="history-item-right">
          <button class="btn btn-secondary btn-sm btn-history-copy" style="padding: 4px 10px; font-size: 0.76rem; min-height: 28px;">
            Copy
          </button>
        </div>
      `;

      const copyBtn = el.querySelector('.btn-history-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(item.textContent || '').then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
          });
        });
      }
    } else {
      el.innerHTML = `
        <div class="history-item-left">
          <span class="history-badge ${item.direction}">${item.direction}</span>
          <div>
            <div class="history-title">${item.peerName}</div>
            <div class="history-time">${item.filesCount} file${item.filesCount > 1 ? 's' : ''} • ${formatBytes(item.totalSize)} • ${dateStr}</div>
          </div>
        </div>
        <div>
          <span style="font-size: 0.78rem; font-weight: 600; color: ${item.status === 'completed' ? 'var(--color-success)' : 'var(--color-warning)'};">
            ${item.status.toUpperCase()}
          </span>
        </div>
      `;
    }

    dom.historyItemsContainer.appendChild(el);
  });
}

dom.btnHistory.addEventListener('click', () => {
  renderHistoryList();
  openModal(dom.modalHistory);
});

dom.btnCloseHistory.addEventListener('click', () => closeModal(dom.modalHistory));
dom.btnDismissHistory.addEventListener('click', () => closeModal(dom.modalHistory));
dom.btnClearHistory.addEventListener('click', () => {
  clearSessionHistory();
  renderHistoryList();
  updateHistoryBadge();
});

/**
 * FAQ & How It Works Modal
 */
dom.btnInfo.addEventListener('click', () => openModal(dom.modalInfo));
dom.btnCloseInfo.addEventListener('click', () => closeModal(dom.modalInfo));
dom.btnDismissInfo.addEventListener('click', () => closeModal(dom.modalInfo));

/**
 * Purge Stale Service Workers & Caches
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const reg of registrations) {
      reg.unregister();
    }
  });
}
if ('caches' in window) {
  caches.keys().then((names) => {
    for (const name of names) {
      caches.delete(name);
    }
  });
}

/**
 * Application Bootstrap
 */
async function initApp() {
  initTheme();
  updateUserProfileUI();
  updateHistoryBadge();
  await fetchNetworkInfo();

  // If first visit, show device selection onboarding
  if (!profile.onboarded) {
    openProfileModal(true);
  }

  // Connect to signaling server
  signaling.connect(profile);
}

initApp();
