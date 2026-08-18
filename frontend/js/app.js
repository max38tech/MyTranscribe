/**
 * MyTranscribe Client Application
 * Handles Web Audio recording, visualizer, faster-whisper communication,
 * disfluency cleaner configuration, and PWA features.
 */

// Application State
const state = {
  isRecording: false,
  isPaused: false,
  pushToTalk: false,
  activeTab: 'clean',
  timerInterval: null,
  recordingStartTime: 0,
  elapsedSeconds: 0,
  
  // Audio & Streams
  audioContext: null,
  analyser: null,
  mediaStream: null,
  mediaRecorder: null,
  recordedChunks: [],
  ws: null,
  
  // Current Transcript Data
  currentData: {
    raw_text: '',
    cleaned_text: '',
    diff_html: '',
    removed_count: 0,
    removed_items: [],
    segments: [],
    duration: 0.0,
  },
  
  // Settings
  settings: {
    remove_vocal_fillers: true,
    remove_repetitions: true,
    remove_verbal_crutches: false,
    custom_fillers: '',
    custom_preserve: '',
    model: 'base',
    language: 'auto',
    device: 'auto',
    theme: 'dark',
  },
};

// DOM Elements
const elements = {
  btnRecord: document.getElementById('btnRecord'),
  recordingOverlay: document.getElementById('recordingOverlay'),
  recordingTimer: document.getElementById('recordingTimer'),
  recordingStatus: document.getElementById('recordingStatus'),
  waveformCanvas: document.getElementById('waveformCanvas'),
  chkPushToTalk: document.getElementById('chkPushToTalk'),
  fileAudioInput: document.getElementById('fileAudioInput'),
  
  // Tabs & Views
  tabClean: document.getElementById('tabClean'),
  tabDiff: document.getElementById('tabDiff'),
  tabSegments: document.getElementById('tabSegments'),
  paneClean: document.getElementById('paneClean'),
  paneDiff: document.getElementById('paneDiff'),
  paneSegments: document.getElementById('paneSegments'),
  
  // Outputs
  cleanedTextOutput: document.getElementById('cleanedTextOutput'),
  rawDiffContent: document.getElementById('rawDiffContent'),
  cleanedDiffContent: document.getElementById('cleanedDiffContent'),
  segmentsList: document.getElementById('segmentsList'),
  removedFillersBadge: document.getElementById('removedFillersBadge'),
  removedCountText: document.getElementById('removedCountText'),
  
  // Stats
  statWordCount: document.getElementById('statWordCount'),
  statCharCount: document.getElementById('statCharCount'),
  statDuration: document.getElementById('statDuration'),
  liveStreamBadge: document.getElementById('liveStreamBadge'),
  
  // Actions
  btnCopy: document.getElementById('btnCopy'),
  copyBtnText: document.getElementById('copyBtnText'),
  btnExportMenu: document.getElementById('btnExportMenu'),
  exportDropdown: document.getElementById('exportDropdown'),
  btnClear: document.getElementById('btnClear'),
  
  // Dictation Elements
  dictationStatusPill: document.getElementById('dictationStatusPill'),
  activeHotkeyLabel: document.getElementById('activeHotkeyLabel'),
  selectHotkey: document.getElementById('selectHotkey'),
  chkSoundChimes: document.getElementById('chkSoundChimes'),

  // Header / Status
  modelStatusPill: document.getElementById('modelStatusPill'),
  activeModelLabel: document.getElementById('activeModelLabel'),
  btnThemeToggle: document.getElementById('btnThemeToggle'),
  btnShareLan: document.getElementById('btnShareLan'),
  btnToggleHistory: document.getElementById('btnToggleHistory'),
  historyCountBadge: document.getElementById('historyCountBadge'),
  btnOpenSettings: document.getElementById('btnOpenSettings'),
  
  // Settings Modal
  settingsModal: document.getElementById('settingsModal'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),
  chkRemoveVocalFillers: document.getElementById('chkRemoveVocalFillers'),
  chkRemoveRepetitions: document.getElementById('chkRemoveRepetitions'),
  chkRemoveVerbalCrutches: document.getElementById('chkRemoveVerbalCrutches'),
  inputCustomFillers: document.getElementById('inputCustomFillers'),
  inputCustomPreserve: document.getElementById('inputCustomPreserve'),
  inputTestCleaner: document.getElementById('inputTestCleaner'),
  outputTestCleaner: document.getElementById('outputTestCleaner'),
  selectModel: document.getElementById('selectModel'),
  selectLanguage: document.getElementById('selectLanguage'),
  selectDevice: document.getElementById('selectDevice'),
  
  // History Drawer
  historyDrawer: document.getElementById('historyDrawer'),
  btnCloseHistory: document.getElementById('btnCloseHistory'),
  inputHistorySearch: document.getElementById('inputHistorySearch'),
  historyList: document.getElementById('historyList'),
  btnClearAllHistory: document.getElementById('btnClearAllHistory'),
  
  // LAN Modal
  lanModal: document.getElementById('lanModal'),
  btnCloseLan: document.getElementById('btnCloseLan'),
  lanUrlsList: document.getElementById('lanUrlsList'),
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  loadStoredSettings();
  initTheme();
  setupEventListeners();
  initVisualizer();
  fetchServerInfo();
  loadHistory();
  registerServiceWorker();
});

// PWA Service Worker Registration
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(() => console.log('PWA Service Worker registered'))
      .catch((err) => console.warn('SW registration error:', err));
  }
}

// Load Settings from LocalStorage
function loadStoredSettings() {
  const saved = localStorage.getItem('mytranscribe_settings');
  if (saved) {
    try {
      state.settings = { ...state.settings, ...JSON.parse(saved) };
    } catch (e) {
      console.error(e);
    }
  }

  // Populate modal inputs
  elements.chkRemoveVocalFillers.checked = state.settings.remove_vocal_fillers;
  elements.chkRemoveRepetitions.checked = state.settings.remove_repetitions;
  elements.chkRemoveVerbalCrutches.checked = state.settings.remove_verbal_crutches;
  elements.inputCustomFillers.value = state.settings.custom_fillers || '';
  elements.inputCustomPreserve.value = state.settings.custom_preserve || '';
  elements.selectModel.value = state.settings.model || 'base';
  elements.selectLanguage.value = state.settings.language || 'auto';
  elements.selectDevice.value = state.settings.device || 'auto';

  if (elements.selectHotkey) {
    elements.selectHotkey.value = state.settings.hotkey || '<ctrl>+<alt>+<space>';
  }
  if (elements.chkSoundChimes) {
    elements.chkSoundChimes.checked = state.settings.sound_chimes !== false;
  }
  updateHotkeyLabel(state.settings.hotkey || '<ctrl>+<alt>+<space>');
}

function updateHotkeyLabel(hotkeyStr) {
  if (!elements.activeHotkeyLabel) return;
  const pretty = hotkeyStr
    .replace(/<ctrl>/gi, 'Ctrl+')
    .replace(/<alt>/gi, 'Alt+')
    .replace(/<shift>/gi, 'Shift+')
    .replace(/<space>/gi, 'Space')
    .replace(/[<>]/g, '')
    .toUpperCase();
  elements.activeHotkeyLabel.textContent = pretty;
}

function saveCurrentSettings() {
  state.settings.remove_vocal_fillers = elements.chkRemoveVocalFillers.checked;
  state.settings.remove_repetitions = elements.chkRemoveRepetitions.checked;
  state.settings.remove_verbal_crutches = elements.chkRemoveVerbalCrutches.checked;
  state.settings.custom_fillers = elements.inputCustomFillers.value.trim();
  state.settings.custom_preserve = elements.inputCustomPreserve.value.trim();
  state.settings.model = elements.selectModel.value;
  state.settings.language = elements.selectLanguage.value;
  state.settings.device = elements.selectDevice.value;
  state.settings.hotkey = elements.selectHotkey ? elements.selectHotkey.value : '<ctrl>+<alt>+<space>';
  state.settings.sound_chimes = elements.chkSoundChimes ? elements.chkSoundChimes.checked : true;

  localStorage.setItem('mytranscribe_settings', JSON.stringify(state.settings));
  updateHotkeyLabel(state.settings.hotkey);

  // Sync model selection with backend
  fetch('/api/models/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: state.settings.model,
      device: state.settings.device,
    }),
  })
    .then((r) => r.json())
    .then((data) => {
      elements.activeModelLabel.textContent = `${data.model} (${data.device} ${data.compute_type})`;
    })
    .catch((err) => console.warn('Could not sync model with server:', err));

  // Sync dictation configuration with backend
  fetch('/api/dictation/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hotkey: state.settings.hotkey,
      enable_sound_chimes: state.settings.sound_chimes,
      enabled: true,
    }),
  }).catch((err) => console.warn('Could not sync dictation config:', err));

  // If there's existing raw text, re-clean it with the new rules
  if (state.currentData.raw_text) {
    recleanCurrentText();
  }
}

// Theme Handling
function initTheme() {
  const savedTheme = localStorage.getItem('mytranscribe_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  state.settings.theme = savedTheme;
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('mytranscribe_theme', next);
  state.settings.theme = next;
}

// Audio Visualizer Setup
let animationFrameId = null;

function initVisualizer() {
  const canvas = elements.waveformCanvas;
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.parentElement.clientHeight * window.devicePixelRatio;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  function draw() {
    animationFrameId = requestAnimationFrame(draw);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!state.isRecording || !state.analyser) {
      // Idle gentle subtle glowing wave
      const time = Date.now() * 0.002;
      ctx.lineWidth = 2 * window.devicePixelRatio;
      ctx.strokeStyle = state.settings.theme === 'dark' ? 'rgba(99, 102, 241, 0.25)' : 'rgba(99, 102, 241, 0.4)';
      ctx.beginPath();
      const midY = canvas.height / 2;
      for (let x = 0; x < canvas.width; x += 5) {
        const y = midY + Math.sin(x * 0.01 + time) * 6 * window.devicePixelRatio;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      return;
    }

    // Active Audio Frequency / Waveform Visualizer
    const bufferLength = state.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    state.analyser.getByteFrequencyData(dataArray);

    const barWidth = (canvas.width / bufferLength) * 2.5;
    let x = 0;

    const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
    grad.addColorStop(0, '#6366f1');
    grad.addColorStop(0.5, '#8b5cf6');
    grad.addColorStop(1, '#ec4899');

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * (canvas.height * 0.85);

      ctx.fillStyle = grad;
      ctx.fillRect(
        x,
        (canvas.height - barHeight) / 2,
        barWidth - 2,
        barHeight
      );

      x += barWidth;
      if (x > canvas.width) break;
    }
  }

  draw();
}

// Recording Controls
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    state.mediaStream = stream;
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = state.audioContext.createMediaStreamSource(stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 128;
    source.connect(state.analyser);

    // Setup MediaRecorder for capturing audio blob
    state.recordedChunks = [];
    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported('audio/webm')) {
      mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    }

    state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    state.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        state.recordedChunks.push(event.data);
      }
    };

    state.mediaRecorder.start(500); // 500ms slices

    // Connect WebSocket for streaming chunks if available
    setupWebSocketStreaming();

    // Start timer & UI state
    state.isRecording = true;
    state.recordingStartTime = Date.now();
    state.elapsedSeconds = 0;
    elements.btnRecord.classList.add('recording');
    elements.recordingOverlay.classList.add('active');
    elements.recordingStatus.textContent = 'Listening... Speak naturally (fillers will be automatically cleaned).';

    state.timerInterval = setInterval(() => {
      state.elapsedSeconds = Math.floor((Date.now() - state.recordingStartTime) / 1000);
      const mins = String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0');
      const secs = String(state.elapsedSeconds % 60).padStart(2, '0');
      elements.recordingTimer.textContent = `${mins}:${secs}`;
    }, 500);

  } catch (err) {
    console.error('Microphone access denied or error:', err);
    elements.recordingStatus.textContent = `Microphone Error: ${err.message}. Please check browser permissions.`;
  }
}

function stopRecording() {
  if (!state.isRecording) return;

  state.isRecording = false;
  elements.btnRecord.classList.remove('recording');
  elements.recordingOverlay.classList.remove('active');
  elements.recordingStatus.textContent = 'Transcribing and cleaning speech with faster-whisper...';

  clearInterval(state.timerInterval);

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
  }

  // Finalize audio file and send to backend
  setTimeout(async () => {
    if (state.recordedChunks.length > 0) {
      const audioBlob = new Blob(state.recordedChunks, { type: state.mediaRecorder.mimeType || 'audio/webm' });
      await processAudioBlob(audioBlob);
    }
  }, 300);

  // Close stream websocket
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ action: 'flush' }));
    setTimeout(() => {
      if (state.ws) state.ws.close();
    }, 500);
  }
}

// WebSocket streaming
function setupWebSocketStreaming() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/ws/stream`;

  try {
    state.ws = new WebSocket(wsUrl);
    state.ws.binaryType = 'arraybuffer';

    state.ws.onopen = () => {
      state.ws.send(
        JSON.stringify({
          action: 'config',
          settings: {
            language: state.settings.language,
            remove_vocal_fillers: state.settings.remove_vocal_fillers,
            remove_verbal_crutches: state.settings.remove_verbal_crutches,
            remove_repetitions: state.settings.remove_repetitions,
            custom_fillers: state.settings.custom_fillers.split(',').filter(Boolean),
            custom_preserve: state.settings.custom_preserve.split(',').filter(Boolean),
          },
        })
      );
    };

    state.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'partial' || data.type === 'final') {
        updateTranscriptDisplay({
          raw_text: data.raw_text,
          cleaned_text: data.cleaned_text,
          diff_html: data.diff_html,
          removed_count: data.removed_count,
          removed_items: data.removed_items,
          duration: data.duration || state.elapsedSeconds,
        });
      } else if (data.type === 'dictation_event') {
        // Dictation happened in external app (WhatsApp, etc.)
        updateTranscriptDisplay({
          raw_text: data.raw_text,
          cleaned_text: data.cleaned_text,
          diff_html: data.diff_html,
          removed_count: data.removed_count,
          removed_items: data.removed_items,
          duration: data.duration,
        });
        loadHistory();
      }
    };
  } catch (e) {
    console.warn('WebSocket streaming unavailable, using standard buffer mode.');
  }
}

// Process Audio via REST /api/transcribe
async function processAudioBlob(blob, title = null) {
  elements.recordingStatus.textContent = 'Analyzing audio with faster-whisper...';

  const formData = new FormData();
  formData.append('file', blob, 'recording.webm');
  if (state.settings.language && state.settings.language !== 'auto') {
    formData.append('language', state.settings.language);
  }
  formData.append('remove_vocal_fillers', state.settings.remove_vocal_fillers);
  formData.append('remove_verbal_crutches', state.settings.remove_verbal_crutches);
  formData.append('remove_repetitions', state.settings.remove_repetitions);
  formData.append('custom_fillers', state.settings.custom_fillers);
  formData.append('custom_preserve', state.settings.custom_preserve);
  if (title) formData.append('title', title);

  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }

    const data = await res.json();
    updateTranscriptDisplay(data);
    elements.recordingStatus.textContent = 'Transcription complete and cleaned!';
    loadHistory(); // Refresh history list
  } catch (err) {
    console.error('Transcription error:', err);
    elements.recordingStatus.textContent = `Transcription failed: ${err.message}`;
  }
}

// Re-clean existing text
async function recleanCurrentText() {
  if (!state.currentData.raw_text) return;

  try {
    const res = await fetch('/api/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: state.currentData.raw_text,
        remove_vocal_fillers: state.settings.remove_vocal_fillers,
        remove_verbal_crutches: state.settings.remove_verbal_crutches,
        remove_repetitions: state.settings.remove_repetitions,
        custom_fillers: state.settings.custom_fillers.split(',').filter(Boolean),
        custom_preserve: state.settings.custom_preserve.split(',').filter(Boolean),
      }),
    });

    const data = await res.json();
    state.currentData.cleaned_text = data.cleaned_text;
    state.currentData.diff_html = data.diff_html;
    state.currentData.removed_count = data.removed_count;
    state.currentData.removed_items = data.removed_items;

    updateTranscriptDisplay(state.currentData);
  } catch (e) {
    console.error('Error re-cleaning text:', e);
  }
}

// Update UI with transcription results
function updateTranscriptDisplay(data) {
  state.currentData = { ...state.currentData, ...data };

  // Update Cleaned text area
  elements.cleanedTextOutput.value = state.currentData.cleaned_text || '';

  // Update Diff views
  elements.rawDiffContent.innerHTML = state.currentData.diff_html || state.currentData.raw_text || 'No speech';
  elements.cleanedDiffContent.textContent = state.currentData.cleaned_text || 'No speech';

  // Update Segments
  if (state.currentData.segments && state.currentData.segments.length > 0) {
    elements.segmentsList.innerHTML = state.currentData.segments
      .map(
        (seg) => `
        <div class="segment-item">
          <div class="segment-time">[${formatTime(seg.start)} &rarr; ${formatTime(seg.end)}]</div>
          <div class="segment-text">${escapeHtml(seg.text)}</div>
        </div>
      `
      )
      .join('');
  }

  // Update Removed Fillers Badge
  if (state.currentData.removed_count > 0) {
    elements.removedFillersBadge.style.display = 'inline-flex';
    const removedWords = [
      ...new Set((state.currentData.removed_items || []).map((i) => i.word)),
    ].slice(0, 4);
    const examples = removedWords.length > 0 ? ` (e.g. ${removedWords.join(', ')})` : '';
    elements.removedCountText.textContent = `${state.currentData.removed_count} filler sound${
      state.currentData.removed_count > 1 ? 's' : ''
    } removed${examples}`;
  } else {
    elements.removedFillersBadge.style.display = 'none';
  }

  // Update Stats
  const words = (state.currentData.cleaned_text || '').trim().split(/\s+/).filter(Boolean).length;
  const chars = (state.currentData.cleaned_text || '').length;
  elements.statWordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  elements.statCharCount.textContent = `${chars} character${chars !== 1 ? 's' : ''}`;
  elements.statDuration.textContent = `${(state.currentData.duration || 0).toFixed(1)}s audio`;
}

// Helpers
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(5, '0')}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// History Management
async function loadHistory(search = '') {
  try {
    const url = `/api/history${search ? `?search=${encodeURIComponent(search)}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();

    elements.historyCountBadge.textContent = data.count || 0;

    if (!data.items || data.items.length === 0) {
      elements.historyList.innerHTML = '<div class="empty-state">No saved transcripts found.</div>';
      return;
    }

    elements.historyList.innerHTML = data.items
      .map(
        (item) => `
        <div class="history-item-card" data-id="${item.id}">
          <div class="history-item-title">${escapeHtml(item.title)}</div>
          <div class="history-item-preview">${escapeHtml(item.cleaned_text || item.raw_text)}</div>
          <div class="history-item-meta">
            <span>${new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • ${item.duration_seconds.toFixed(1)}s</span>
            ${item.removed_count > 0 ? `<span class="tag-clean">-${item.removed_count} fillers</span>` : ''}
          </div>
        </div>
      `
      )
      .join('');

    // Attach click listeners to history cards
    elements.historyList.querySelectorAll('.history-item-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-id');
        const item = data.items.find((i) => i.id === id);
        if (item) {
          updateTranscriptDisplay({
            raw_text: item.raw_text,
            cleaned_text: item.cleaned_text,
            removed_count: item.removed_count,
            removed_items: item.removed_items,
            duration: item.duration_seconds,
          });
          elements.historyDrawer.classList.remove('open');
        }
      });
    });
  } catch (err) {
    console.error('Error loading history:', err);
  }
}

// Server Info & Mobile / LAN URLs
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    elements.activeModelLabel.textContent = `${data.active_model} (${data.device} ${data.compute_type})`;

    if (data.local_ips && data.local_ips.length > 0) {
      elements.lanUrlsList.innerHTML = data.local_ips
        .map(
          (ip) => `
          <div class="lan-url-pill">http://${ip}:${data.port}/</div>
        `
        )
        .join('');
    }
  } catch (err) {
    console.warn('Server info unavailable:', err);
  }
}

// Event Listeners setup
function setupEventListeners() {
  // Record button click
  elements.btnRecord.addEventListener('click', () => {
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  // Push to talk toggle
  elements.chkPushToTalk.addEventListener('change', (e) => {
    state.pushToTalk = e.target.checked;
    elements.recordingStatus.textContent = state.pushToTalk
      ? 'Push-to-Talk active: Hold Spacebar to speak.'
      : 'Click microphone or press Spacebar to record.';
  });

  // Spacebar Push to talk listener
  window.addEventListener('keydown', (e) => {
    if (
      e.code === 'Space' &&
      !e.repeat &&
      document.activeElement.tagName !== 'TEXTAREA' &&
      document.activeElement.tagName !== 'INPUT'
    ) {
      if (state.pushToTalk && !state.isRecording) {
        e.preventDefault();
        startRecording();
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (
      e.code === 'Space' &&
      document.activeElement.tagName !== 'TEXTAREA' &&
      document.activeElement.tagName !== 'INPUT'
    ) {
      if (state.pushToTalk && state.isRecording) {
        e.preventDefault();
        stopRecording();
      }
    }
  });

  // File Audio Upload
  elements.fileAudioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await processAudioBlob(file, file.name);
      e.target.value = '';
    }
  });

  // Tab switcher
  [elements.tabClean, elements.tabDiff, elements.tabSegments].forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      state.activeTab = tab;

      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      if (tab === 'clean') elements.paneClean.classList.add('active');
      if (tab === 'diff') elements.paneDiff.classList.add('active');
      if (tab === 'segments') elements.paneSegments.classList.add('active');
    });
  });

  // Copy Clean Text
  elements.btnCopy.addEventListener('click', () => {
    const text = elements.cleanedTextOutput.value;
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
      elements.copyBtnText.textContent = 'Copied!';
      setTimeout(() => {
        elements.copyBtnText.textContent = 'Copy';
      }, 2000);
    });
  });

  // Export Dropdown
  elements.btnExportMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.exportDropdown.classList.toggle('show');
  });

  window.addEventListener('click', () => {
    elements.exportDropdown.classList.remove('show');
  });

  elements.exportDropdown.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const format = btn.getAttribute('data-export');
      exportTranscript(format);
    });
  });

  // Clear text
  elements.btnClear.addEventListener('click', () => {
    state.currentData = {
      raw_text: '',
      cleaned_text: '',
      diff_html: '',
      removed_count: 0,
      removed_items: [],
      segments: [],
      duration: 0.0,
    };
    updateTranscriptDisplay(state.currentData);
  });

  // Theme Toggle
  elements.btnThemeToggle.addEventListener('click', toggleTheme);

  // Settings Modal
  elements.btnOpenSettings.addEventListener('click', () => {
    elements.settingsModal.classList.add('show');
    testCleanerLive();
  });
  elements.modelStatusPill.addEventListener('click', () => {
    elements.settingsModal.classList.add('show');
  });
  if (elements.dictationStatusPill) {
    elements.dictationStatusPill.addEventListener('click', () => {
      elements.settingsModal.classList.add('show');
    });
  }
  elements.btnCloseSettings.addEventListener('click', () => {
    elements.settingsModal.classList.remove('show');
  });
  elements.btnSaveSettings.addEventListener('click', () => {
    saveCurrentSettings();
    elements.settingsModal.classList.remove('show');
  });

  // Cleaner Sandbox Live Test
  let testDebounce = null;
  elements.inputTestCleaner.addEventListener('input', () => {
    clearTimeout(testDebounce);
    testDebounce = setTimeout(testCleanerLive, 200);
  });

  // History Drawer
  elements.btnToggleHistory.addEventListener('click', () => {
    elements.historyDrawer.classList.toggle('open');
  });
  elements.btnCloseHistory.addEventListener('click', () => {
    elements.historyDrawer.classList.remove('open');
  });
  elements.inputHistorySearch.addEventListener('input', (e) => {
    loadHistory(e.target.value);
  });
  elements.btnClearAllHistory.addEventListener('click', async () => {
    if (confirm('Clear all transcript history?')) {
      await fetch('/api/history', { method: 'DELETE' });
      loadHistory();
    }
  });

  // Mobile / LAN Modal
  elements.btnShareLan.addEventListener('click', () => {
    elements.lanModal.classList.add('show');
  });
  elements.btnCloseLan.addEventListener('click', () => {
    elements.lanModal.classList.remove('show');
  });
}

// Live test cleaner in settings sandbox
async function testCleanerLive() {
  const text = elements.inputTestCleaner.value;
  if (!text) {
    elements.outputTestCleaner.textContent = '';
    return;
  }

  try {
    const res = await fetch('/api/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        remove_vocal_fillers: elements.chkRemoveVocalFillers.checked,
        remove_verbal_crutches: elements.chkRemoveVerbalCrutches.checked,
        remove_repetitions: elements.chkRemoveRepetitions.checked,
        custom_fillers: elements.inputCustomFillers.value.split(',').filter(Boolean),
        custom_preserve: elements.inputCustomPreserve.value.split(',').filter(Boolean),
      }),
    });
    const data = await res.json();
    elements.outputTestCleaner.textContent = data.cleaned_text || '(all text removed)';
  } catch (e) {
    console.error(e);
  }
}

// Export Transcript File Helper
function exportTranscript(format) {
  const text = elements.cleanedTextOutput.value || '';
  let content = '';
  let filename = `transcript_${new Date().toISOString().slice(0, 10)}`;
  let mimeType = 'text/plain';

  if (format === 'txt') {
    content = text;
    filename += '.txt';
  } else if (format === 'md') {
    content = `# Transcript\n\n**Date:** ${new Date().toLocaleString()}\n**Duration:** ${(state.currentData.duration || 0).toFixed(1)}s\n\n${text}\n`;
    filename += '.md';
  } else if (format === 'srt') {
    content = (state.currentData.segments || [])
      .map((seg, idx) => {
        return `${idx + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}\n`;
      })
      .join('\n');
    filename += '.srt';
  } else if (format === 'json') {
    content = JSON.stringify(state.currentData, null, 2);
    filename += '.json';
    mimeType = 'application/json';
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatSrtTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
