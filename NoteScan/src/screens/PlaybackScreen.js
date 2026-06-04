import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  ScrollView,
  Alert,
  Platform,
  StatusBar,
  Modal,
  FlatList,
  Animated,
  Easing,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'react-native';
import { File, Paths } from 'expo-file-system/next';
import * as Sharing from 'expo-sharing';
import Slider from '@react-native-community/slider';
import { Feather } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AudioPlaybackService } from '../services/AudioPlaybackService';
import { PlaybackVisualization } from '../components/PlaybackVisualization';
import { RenderedScoreView } from '../components/RenderedScoreView';
import { ScoreInfoPanel } from '../components/ScoreInfoPanel';
import { OMRSettings } from '../services/OMRSettings';
import { OMRCacheService } from '../services/OMRCacheService';
import { NativeAudioBridge } from '../services/NativeAudioBridge';
import { separateSATBFromEvents } from '../services/satb-from-events';
import { getStatusBarStyleForTheme } from '../theme/themes';
import { buildThemedLogoHtml } from '../utils/logoTheme';

/* ─── Theme ─── */
const palette = {
  background: '#F9F7F1',
  surface: '#FBFAF5',
  surfaceStrong: '#F1EEE4',
  border: '#D6D0C4',
  ink: '#3E3C37',
  inkMuted: '#6E675E',
};

const barPalette = {
  bar: '#1C1B19',
  barRaised: '#2A2925',
  barBorder: '#3C3A35',
  barText: '#F3F1EA',
  barTextMuted: '#C8C4BA',
  accent: '#E05A2A',
};

// Temporary debug switch: disable pitch panel to isolate playback behavior.
const ENABLE_PITCH_VIEW = false;
const AUDIO_TIMELINE_MODE = 'canonical';
const RENDERED_PLAYHEAD_MODES = ['line', 'notes', 'both'];
const RENDERED_LINE_COLORS = ['#2F8F6B', '#F08A45', '#CC4B37', '#7A5A3A', 'none'];
const RENDERED_NOTE_COLORS = ['#F08A45', '#CC4B37', '#2D8CFF'];
const RENDER_VIEW_PRESETS = ['smart', 'fit'];
const RENDER_VISUAL_LEAD_MS = 0;
const PLAYBACK_UI_UPDATE_MS = 16;
const PITCH_PIPE_NOTES = [
  { label: 'C4', hz: 262 },
  { label: 'C#4', hz: 277 },
  { label: 'D4', hz: 294 },
  { label: 'D#4', hz: 311 },
  { label: 'E4', hz: 330 },
  { label: 'F4', hz: 349 },
  { label: 'F#4', hz: 370 },
  { label: 'G4', hz: 392 },
  { label: 'G#4', hz: 415 },
  { label: 'A4', hz: 440 },
  { label: 'A#4', hz: 466 },
  { label: 'B4', hz: 494 },
  { label: 'C5', hz: 523 },
];
const PITCH_PIPE_MIN_HZ = PITCH_PIPE_NOTES[0].hz;
const PITCH_PIPE_MAX_HZ = PITCH_PIPE_NOTES[PITCH_PIPE_NOTES.length - 1].hz;

const INSTRUMENT_PRIORITY = [
  'electric grand',
  'grand piano',
  'violin',
  'jazz guitar',
];

const SOUND_FONT_SOURCES = [
  {
    key: 'default',
    label: 'Default',
    asset: require('../../assets/SheetMusicScanner.sf2'),
  },
  {
    key: 'choir',
    label: 'Choir',
    asset: require('../../assets/choir_choral_aahhs_4959kb.sf2'),
  },
];

function orderInstrumentPresets(presets) {
  const list = Array.isArray(presets) ? [...presets] : [];
  if (!list.length) return list;

  const getRank = (name) => {
    const normalized = String(name || '').toLowerCase();
    const idx = INSTRUMENT_PRIORITY.findIndex((needle) => normalized.includes(needle));
    return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
  };

  return list.sort((a, b) => {
    const rankA = getRank(a?.name);
    const rankB = getRank(b?.name);
    if (rankA !== rankB) return rankA - rankB;
    return (a?.index ?? 0) - (b?.index ?? 0);
  });
}


function buildPitchTimelineFromRawEvents(noteEvents, tempoBpm) {
  if (!Array.isArray(noteEvents) || !noteEvents.length || !Number.isFinite(tempoBpm) || tempoBpm <= 0) {
    return [];
  }
  const spb = 60 / tempoBpm;
  return noteEvents
    .map((e) => ({
      time: e.beatOffset * spb,
      endTime: (e.beatOffset + e.durationBeats) * spb,
      midiNote: e.midiNote,
      voice: e.voice,
    }))
    .sort((a, b) => a.time - b.time);
}

function normalizeVoiceLabel(voice) {
  const raw = String(voice || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 's' || raw === 'soprano' || raw.includes('soprano')) return 'Soprano';
  if (raw === 'a' || raw === 'alto' || raw.includes('alto')) return 'Alto';
  if (raw === 't' || raw === 'tenor' || raw.includes('tenor')) return 'Tenor';
  if (raw === 'b' || raw === 'bass' || raw.includes('bass')) return 'Bass';
  return '';
}

function isVoiceAllowed(voiceSelection, entryVoice) {
  if (!voiceSelection || Object.values(voiceSelection).every(Boolean)) return true;
  const canonical = normalizeVoiceLabel(entryVoice);
  if (canonical && Object.prototype.hasOwnProperty.call(voiceSelection, canonical)) {
    return !!voiceSelection[canonical];
  }
  return true;
}

function getLiteralPlaybackNotes(scoreData) {
  return scoreData?.notes || [];
}

function getNearestPitchPipeIndex(hz) {
  const safeHz = Number.isFinite(hz) ? hz : 440;
  let bestIdx = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PITCH_PIPE_NOTES.length; i += 1) {
    const distance = Math.abs(PITCH_PIPE_NOTES[i].hz - safeHz);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/* ─── Component ─── */
export const PlaybackScreen = ({ imageUri, scoreData: incomingScoreData, scoreEntry, onNavigateBack, onScoredSaved, theme: incomingTheme }) => {
  const insets = useSafeAreaInsets();
  const theme = {
    background: incomingTheme?.background || palette.background,
    surface: incomingTheme?.surface || palette.surface,
    surfaceStrong: incomingTheme?.surfaceStrong || palette.surfaceStrong,
    border: incomingTheme?.border || palette.border,
    ink: incomingTheme?.ink || palette.ink,
    inkMuted: incomingTheme?.inkMuted || palette.inkMuted,
    accent: incomingTheme?.accent || barPalette.accent,
    success: incomingTheme?.success || '#2A7B3D',
    danger: incomingTheme?.danger || '#D9534F',
  };
  const loadingEyeHtml = useMemo(() => buildThemedLogoHtml(theme), [theme]);
  /* ── State ── */
  const [scoreData, setScoreData] = useState(incomingScoreData || null);
  const [scoreError, setScoreError] = useState(null);
  const [processing, setProcessing] = useState(!incomingScoreData); // Don't process if scoreData already provided
  const [processingStage, setProcessingStage] = useState('');
  const [scanProgress, setScanProgress] = useState(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [playPending, setPlayPending] = useState(false);
  const [tempo, setTempo] = useState(incomingScoreData?.metadata?.tempo || 120);
  const [sliderTempo, setSliderTempo] = useState(incomingScoreData?.metadata?.tempo || 120);
  const [showAudioControls, setShowAudioControls] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [showPitchPipeModal, setShowPitchPipeModal] = useState(false);
  const [pitchHz, setPitchHz] = useState(440);
  const [pitchSliderHz, setPitchSliderHz] = useState(440);
  const [pitchPipeIndex, setPitchPipeIndex] = useState(() => getNearestPitchPipeIndex(440));

  const [playbackTime, setPlaybackTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [seekSliderValue, setSeekSliderValue] = useState(0);
  const [isSeekSliding, setIsSeekSliding] = useState(false);
  const [preparingStatusText, setPreparingStatusText] = useState('');

  // Instrument preset selection
  const [availablePresets, setAvailablePresets] = useState([]);
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(0); // UI selection
  const [appliedPresetIndex, setAppliedPresetIndex] = useState(0);   // debounced/applied index used for heavy work
  const [isApplyingPreset, setIsApplyingPreset] = useState(false);
  const _applyTimerRef = useRef(null);
  const [selectedSoundFontKey, setSelectedSoundFontKey] = useState('default');
  const [loadingSoundFontKey, setLoadingSoundFontKey] = useState('');
  const [showInstrumentPicker, setShowInstrumentPicker] = useState(false);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

  // Cursor data
  const [pitchTimeline, setPitchTimeline] = useState([]);
  const [scoreViewMode, setScoreViewMode] = useState('rendered');
  const [renderedPlayheadMode, setRenderedPlayheadMode] = useState('notes');
  const [renderedLineColorIdx, setRenderedLineColorIdx] = useState(1);
  const [renderedNoteColorIdx, setRenderedNoteColorIdx] = useState(1);
  const [renderViewPreset, setRenderViewPreset] = useState('fit');
  const [preparedPlaybackEvents, setPreparedPlaybackEvents] = useState([]);
  const [preparedTimepointGraph, setPreparedTimepointGraph] = useState([]);
  const [preparedTotalBeats, setPreparedTotalBeats] = useState(0);

  const audioFileUriRef = useRef(null);
  const mixedVoiceSelectionKeyRef = useRef('');
  const prepareIdRef = useRef(0);
  const renderTempoRef = useRef(incomingScoreData?.metadata?.tempo || 120);
  const webAudioReadyRef = useRef(false);
  const preparedScoreRef = useRef(null);
  const fallbackWavPreparedRef = useRef(false);
  const fallbackRenderSignatureRef = useRef('');
  const rawNoteEventsRef = useRef([]);
  const renderedScoreRef = useRef(null);
  const lastPlaybackUiUpdateRef = useRef(0);
  const lastVisualTimeRef = useRef(0);
  const transportAnchorSecRef = useRef(0);
  const transportAnchorTsRef = useRef(0);
  const loadingBarAnim = useRef(new Animated.Value(0)).current;
  const currentScanIdRef = useRef(0);
  const playPressLockRef = useRef(false);
  const nativeAudioBridgeRef = useRef(new NativeAudioBridge());

  const [voiceSelection, setVoiceSelection] = useState({
    Soprano: true,
    Alto: true,
    Tenor: true,
    Bass: true,
  });

  const effectiveVoiceSelection = useMemo(() => {
    return voiceSelection;
  }, [voiceSelection]);

  const persistScannedScore = useCallback(async (result, engineKey) => {
    if (typeof onScoredSaved !== 'function' || !result) return;
    try {
      await onScoredSaved(result, engineKey);
    } catch (e) {
      console.warn('PlaybackScreen: failed to persist scanned score', e?.message || e);
    }
  }, [onScoredSaved]);

  const playbackVoiceSelection = useMemo(() => {
    return effectiveVoiceSelection;
  }, [effectiveVoiceSelection]);

  const loadSoundFontSource = useCallback(async (sourceKey) => {
    const source = SOUND_FONT_SOURCES.find((item) => item.key === sourceKey) || SOUND_FONT_SOURCES[0];
    if (!source) return;
    setLoadingSoundFontKey(source.key);
    try {
      await AudioPlaybackService.loadSoundFont(source.asset, { forceReload: true });
      const presets = orderInstrumentPresets(AudioPlaybackService.getAvailablePresets());
      setAvailablePresets(presets);
      const firstIdx = presets[0]?.index ?? 0;
      setSelectedPresetIndex(firstIdx);
      // Immediately apply when loading a new SoundFont so the app is ready.
      setAppliedPresetIndex(firstIdx);
      setIsApplyingPreset(false);
      AudioPlaybackService.selectPreset(firstIdx);
      setSelectedSoundFontKey(source.key);
    } catch (e) {
      console.warn('Failed to load SoundFont source:', e?.message || e);
      Alert.alert('SoundFont load failed', e?.message || 'Unable to load selected instrument bank.');
    } finally {
      setLoadingSoundFontKey('');
    }
  }, []);

  const allVisibleVoicesSelected = useMemo(() => {
    return Object.values(voiceSelection).every(Boolean);
  }, [voiceSelection]);

  const activeClefPreset = useMemo(() => {
    const s = !!voiceSelection.Soprano;
    const a = !!voiceSelection.Alto;
    const t = !!voiceSelection.Tenor;
    const b = !!voiceSelection.Bass;
    if (s && a && t && b) return 'both';
    if (s && a && !t && !b) return 'upper';
    if (!s && !a && t && b) return 'lower';
    return 'custom';
  }, [voiceSelection]);

  const getVoiceSelectionKey = useCallback((selection) => {
    const ordered = ['Soprano', 'Alto', 'Tenor', 'Bass'];
    return ordered.map((voice) => (selection?.[voice] ? '1' : '0')).join('');
  }, []);

  const getSelectedVoiceNames = useCallback((selection) => {
    const ordered = ['Soprano', 'Alto', 'Tenor', 'Bass'];
    const active = ordered.filter((voice) => !!selection?.[voice]);
    if (active.length === 0) return 'selected voice';
    if (active.length === 1) return active[0];
    if (active.length === 2) return `${active[0]} and ${active[1]}`;
    return `${active.slice(0, -1).join(', ')}, and ${active[active.length - 1]}`;
  }, []);

  const commitVoiceSelection = useCallback((nextSelection) => {
    setVoiceSelection(nextSelection);
  }, []);

  const updateVoiceSelectionForClef = useCallback((updater) => {
    setVoiceSelection((prev) => {
      const next = updater({
        Soprano: !!prev.Soprano,
        Alto: !!prev.Alto,
        Tenor: !!prev.Tenor,
        Bass: !!prev.Bass,
      });
      return next;
    });
  }, []);

  const changeClefFilter = useCallback((nextFilter) => {
    mixedVoiceSelectionKeyRef.current = '';
    if (nextFilter === 'upper') {
      commitVoiceSelection({ Soprano: true, Alto: true, Tenor: false, Bass: false });
      return;
    }
    if (nextFilter === 'lower') {
      commitVoiceSelection({ Soprano: false, Alto: false, Tenor: true, Bass: true });
      return;
    }
    commitVoiceSelection({ Soprano: true, Alto: true, Tenor: true, Bass: true });
  }, [commitVoiceSelection]);

  const scanningFileName = useMemo(() => {
    if (!imageUri) return 'Selected file';
    try {
      const raw = decodeURIComponent(String(imageUri).split('/').pop() || 'Selected file');
      if (raw.length <= 30) return raw;
      return `${raw.slice(0, 14)}...${raw.slice(-12)}`;
    } catch (_) {
      const raw = String(imageUri).split('/').pop() || 'Selected file';
      if (raw.length <= 30) return raw;
      return `${raw.slice(0, 14)}...${raw.slice(-12)}`;
    }
  }, [imageUri]);

  const headerTitle = useMemo(() => {
    const raw = String(scoreData?.metadata?.title || '').trim();
    if (!raw) return 'Score Viewer';

    const normalized = raw
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (/^scanned score/i.test(normalized)) {
      return 'Scanned Score';
    }

    if (normalized.length > 34) {
      return `${normalized.slice(0, 31)}...`;
    }

    return normalized;
  }, [scoreData?.metadata?.title]);

  useEffect(() => {
    // Try native bridge first
    const nativeBridge = nativeAudioBridgeRef.current;
    if (nativeBridge?.isAvailable && nativeBridge?.isPlaying) {
      try {
        console.log(`[Native] Pitch updating to ${pitchHz} Hz`);
        nativeBridge.setPitch(pitchHz).catch((e) => {
          console.warn('Native pitch change failed, using JS:', e.message);
          AudioPlaybackService.setPitchHz(pitchHz);
        });
      } catch (e) {
        console.warn('Native bridge error:', e.message);
        AudioPlaybackService.setPitchHz(pitchHz);
      }
    } else {
      AudioPlaybackService.setPitchHz(pitchHz);
    }
    
    fallbackWavPreparedRef.current = false;
    fallbackRenderSignatureRef.current = '';

    // Legacy fallback cannot retune already-rendered WAV in-place.
    if ((isPlaying || isPaused) && !webAudioReadyRef.current) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
      lastVisualTimeRef.current = 0;
      transportAnchorSecRef.current = 0;
      transportAnchorTsRef.current = 0;
      renderedScoreRef.current?.resetPlayback?.();
    }
  }, [pitchHz]);

  useEffect(() => {
    if (!processing) {
      setScanProgress(0);
      loadingBarAnim.setValue(0);
      return;
    }

    const barAnim = Animated.timing(loadingBarAnim, {
      toValue: scanProgress,
      duration: 240,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    });

    barAnim.start();

    return () => {
      barAnim.stop();
    };
  }, [processing, scanProgress, loadingBarAnim]);

  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => {
      setScanProgress((prev) => {
        if (prev >= 0.95) return prev;
        return Math.min(0.95, prev + 0.012);
      });
    }, 90);
    return () => clearInterval(t);
  }, [processing]);

  const cancelScan = useCallback(() => {
    // Invalidate any in-flight async scan work and return control to user immediately.
    currentScanIdRef.current += 1;
    setProcessing(false);
    setProcessingStage('');
    setScoreError('Scan cancelled by user');
  }, []);

  const updateScanProgress = useCallback((next) => {
    if (!Number.isFinite(next)) return;
    setScanProgress((prev) => Math.max(prev, Math.min(1, next)));
  }, []);

  /* ── Process score via selected OMR engine (with caching) ── */
  const processScore = useCallback(async () => {
    const scanId = currentScanIdRef.current + 1;
    currentScanIdRef.current = scanId;
    const isCancelled = () => currentScanIdRef.current !== scanId;

    if (!imageUri) {
      setProcessing(false);
      setScoreError('No image selected');
      return;
    }
    setProcessing(true);
    setScoreError(null);
    setScanProgress(0.04);
    const selectedEngine = OMRSettings.getEngine();

    const ENGINE_LABELS = {
      zemsky: 'Music eye',
    };

    const ENGINE_TIMEOUTS = {
      zemsky: {
        baseMs: 120000,
        perMbMs: 15000,
        maxMs: 420000,
        stallMs: 180000,
      },
    };

    const runEngine = async (engineKey, isFallback = false) => {
      const engineName = ENGINE_LABELS[engineKey] || engineKey;
      const timeoutCfg = ENGINE_TIMEOUTS[engineKey] || {
        baseMs: 120000,
        perMbMs: 10000,
        maxMs: 360000,
        stallMs: 90000,
      };

      const imageBytes = (() => {
        try {
          const f = new File(imageUri);
          return Number.isFinite(f.size) ? f.size : 0;
        } catch (_) {
          return 0;
        }
      })();
      const imageMb = imageBytes > 0 ? imageBytes / (1024 * 1024) : 0;
      const hardTimeoutMs = Math.min(
        timeoutCfg.maxMs,
        timeoutCfg.baseMs + Math.round(imageMb * timeoutCfg.perMbMs)
      );
      const stallTimeoutMs = timeoutCfg.stallMs;

      if (isFallback) {
        setProcessingStage(`Primary engine failed. Trying ${engineName}...`);
      } else {
        setProcessingStage(`Starting ${engineName}...`);
      }

      let service;
      if (engineKey === selectedEngine) {
        service = OMRSettings.getService();
      } else if (engineKey === 'zemsky') {
        const { ZemskyEmulatorService } = require('../services/ZemskyEmulatorService');
        service = ZemskyEmulatorService;
      } else {
        service = OMRSettings.getService();
      }

      // Skip blocking health probes here. They can add multi-second delays
      // when endpoint probing retries; processSheet already handles connectivity.

      let watchdog = null;
      let lastActivityAt = Date.now();
      const startedAt = Date.now();

      const reportProgressStage = (stage) => {
        if (isCancelled()) return;
        lastActivityAt = Date.now();

        const raw = String(stage || '');
        const lower = raw.toLowerCase();
        let displayStage = raw;

        if (lower.includes('processing') || lower.includes('starting')) {
          displayStage = 'Loading image data...';
        } else if (lower.includes('staff')) {
          displayStage = '🎼 Detecting staff lines...';
        } else if (lower.includes('symbol') || lower.includes('detect')) {
          displayStage = '📍 Classifying notes & symbols...';
        } else if (lower.includes('note')) {
          displayStage = '🎵 Extracting note values...';
        } else if (lower.includes('musicxml') || lower.includes('building')) {
          displayStage = '✓ Building MusicXML...';
        }
        setProcessingStage(displayStage);
      };

      const watchdogPromise = new Promise((_, rej) => {
        watchdog = setInterval(() => {
          if (isCancelled()) {
            rej(new Error('Scan cancelled'));
            return;
          }
          const now = Date.now();
          const totalElapsed = now - startedAt;
          const idleElapsed = now - lastActivityAt;

          if (idleElapsed > stallTimeoutMs) {
            rej(new Error(
              `${engineName} appears stalled (no progress for ${Math.round(stallTimeoutMs / 1000)}s)`
            ));
            return;
          }

          if (totalElapsed > hardTimeoutMs) {
            rej(new Error(
              `${engineName} timed out after ${Math.round(hardTimeoutMs / 1000)}s`
            ));
          }
        }, 1000);
      });

      let result;
      try {
        result = await Promise.race([
          service.processSheet(imageUri, reportProgressStage),
          watchdogPromise,
        ]);
        if (isCancelled()) throw new Error('Scan cancelled');
      } finally {
        if (watchdog) clearInterval(watchdog);
      }

      const totalEvents = result.notes?.length || 0;
      const noteCount = result.notes?.filter((n) => n.type === 'note').length || 0;
      const restCount = result.notes?.filter((n) => n.type === 'rest').length || 0;
      console.log(`🎼 ${engineName} result: ${noteCount} notes, ${restCount} rests (${totalEvents} events), source=${result.metadata?.source}`);
      return { result, engineKey, engineName };
    };

    // ── Check cache first ──
    const CACHE_LOOKUP_TIMEOUT_MS = 1500;
    let skipCacheForThisRun = false;
    setProcessingStage('Checking cache...');
    try {
      const cached = await Promise.race([
        OMRCacheService.get(imageUri, selectedEngine),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Cache lookup timed out')), CACHE_LOOKUP_TIMEOUT_MS)),
      ]);
      if (isCancelled()) return;
      if (cached && cached.notes && cached.notes.length > 0) {
        const cachedEngineName = ENGINE_LABELS[selectedEngine] || selectedEngine;
        const cachedNotes = cached.notes.filter((n) => n.type === 'note').length;
        const cachedRests = cached.notes.filter((n) => n.type === 'rest').length;
        console.log(`🗂️ Cache hit — ${cachedNotes} notes, ${cachedRests} rests (${cached.notes.length} events), skipping ${cachedEngineName}`);
        setScoreData(cached);
        await persistScannedScore(cached, selectedEngine);
        setScanProgress(1);
        setProcessing(false);
        setProcessingStage('');
        return;
      }
    } catch (e) {
      console.warn('Cache lookup failed or stalled, proceeding with OMR:', e.message);
      skipCacheForThisRun = true;
      setProcessingStage('Cache slow. Continuing scan...');
    }

    // ── No cache — run OMR engine ──
    try {
      let run = await runEngine(selectedEngine, false);
      if (isCancelled()) return;

      if (!run.result?.notes || run.result.notes.length === 0) {
        throw new Error(`${run.engineName} could not detect any notes`);
      }

      setProcessingStage('✓ Finalizing score...');
      updateScanProgress(1);

      const detectedTempo = Number(run.result?.metadata?.tempo);
      if (Number.isFinite(detectedTempo) && detectedTempo >= 40 && detectedTempo <= 240) {
        setSliderTempo(Math.round(detectedTempo));
        setTempo(Math.round(detectedTempo));
      }

      setScoreData(run.result);
      await persistScannedScore(run.result, run.engineKey);
      if (!skipCacheForThisRun) {
        OMRCacheService.set(imageUri, run.engineKey, run.result).catch(() => {});
      }
    } catch (e) {
      if ((e?.message || '') === 'Scan cancelled') {
        return;
      }
      console.warn(`Primary engine (${selectedEngine}) failed:`, e?.message || e);
      setScoreError(e?.message || 'Failed to process music sheet');
    } finally {
      if (isCancelled()) return;
      // Let users see the bar complete before switching away from the loading UI.
      setScanProgress(1);
      await new Promise((resolve) => setTimeout(resolve, 260));
      setProcessing(false);
      setProcessingStage('');
    }
  }, [imageUri, persistScannedScore, updateScanProgress]);

  useEffect(() => {
    // Only process image if imageUri is provided; skip if scoreData was already loaded
    if (imageUri && !incomingScoreData) {
      processScore();
    }
  }, [processScore, imageUri, incomingScoreData]);

  useEffect(() => {
    loadSoundFontSource(selectedSoundFontKey);
  }, [loadSoundFontSource, selectedSoundFontKey]);

  useEffect(() => {
    if (scoreViewMode !== 'rendered') return;
    renderedScoreRef.current?.resetPlayback?.();
  }, [scoreViewMode]);

  useEffect(() => {
    if (scoreViewMode !== 'rendered') return;
    renderedScoreRef.current?.setVoiceSelection?.(effectiveVoiceSelection);
  }, [scoreViewMode, effectiveVoiceSelection]);

  // Clear any pending apply timer on unmount
  useEffect(() => {
    return () => {
      if (_applyTimerRef.current) {
        clearTimeout(_applyTimerRef.current);
        _applyTimerRef.current = null;
      }
    };
  }, []);

  /* ── Phase 1: Prepare note events when scoreData or instrument changes ── */
  /* Parse notes once, build event list. No audio rendering here — just data.  */
  useEffect(() => {
    if (!scoreData) return;
    let cancelled = false;

    if (preparedScoreRef.current !== scoreData) {
      preparedScoreRef.current = scoreData;
      fallbackWavPreparedRef.current = false;
      fallbackRenderSignatureRef.current = '';
    }

    AudioPlaybackService.initAudio();

    const doPrepare = async () => {
      const myId = ++prepareIdRef.current;

      // Stop current playback
      await AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);

      setPreparing(true);
      try {
        AudioPlaybackService.selectPreset(appliedPresetIndex);
        renderTempoRef.current = tempo;

        const playbackNotes = getLiteralPlaybackNotes(scoreData);

        // Prepare playback note events through the service path.
        const evtResult = AudioPlaybackService.prepareNoteEvents(playbackNotes, {
          measureBeats: scoreData?.metadata?.measureBeats,
        });
        rawNoteEventsRef.current = AudioPlaybackService.getPreparedNoteEvents();
        setPreparedPlaybackEvents(rawNoteEventsRef.current);
        setPreparedTimepointGraph(AudioPlaybackService.getPreparedTimepointGraph());
        setPreparedTotalBeats(AudioPlaybackService.getPreparedTotalBeats());
        const canUseWebAudio = AudioPlaybackService.isWebAudioAvailable() && !!evtResult;
        if (cancelled || myId !== prepareIdRef.current) return;

        setPitchTimeline(
          ENABLE_PITCH_VIEW
            ? buildPitchTimelineFromRawEvents(rawNoteEventsRef.current, tempo)
            : []
        );

        if (canUseWebAudio) {
          // Web Audio path: note events prepared, build timing map
          AudioPlaybackService._useWebAudio = true;
          webAudioReadyRef.current = true;
          mixedVoiceSelectionKeyRef.current = '';
          const dur = evtResult.totalBeats * (60 / tempo);
          setTotalDuration(dur);
          setPlaybackTime(0);
          fallbackRenderSignatureRef.current = '';
          console.log(`✅ Web Audio ready [${myId}]: ${dur.toFixed(1)}s, ${evtResult.noteEvents.length} events`);
        } else {
          // Legacy WAV path: render once per loaded score for basic fallback playback.
          // UI interactions (voice/tempo/preset changes) should not regenerate WAV.
          webAudioReadyRef.current = false;
          AudioPlaybackService._useWebAudio = false;
          const renderSignature = `${appliedPresetIndex}|${Math.round(pitchHz * 10)}|${tempo}`;
          const needsPreRender = !fallbackWavPreparedRef.current || fallbackRenderSignatureRef.current !== renderSignature;
          if (needsPreRender) {
            const result = await AudioPlaybackService.preRenderVoiceTracks(playbackNotes, tempo, {
              measureBeats: scoreData?.metadata?.measureBeats,
            });
            if (cancelled || myId !== prepareIdRef.current) return;
            if (result) {
              fallbackWavPreparedRef.current = true;
              fallbackRenderSignatureRef.current = renderSignature;
              await doMix(myId, playbackVoiceSelection);
            } else {
              throw new Error('Clean pipeline requires beatOffset timing data; legacy prepare fallback is disabled.');
            }
          } else {
            const fallbackBeats = Number.isFinite(evtResult?.totalBeats)
              ? evtResult.totalBeats
              : 0;
            if (fallbackBeats > 0) {
              setTotalDuration(fallbackBeats * (60 / tempo));
            }
            setPlaybackTime(0);
            await doMix(myId, playbackVoiceSelection);
          }
        }
      } catch (e) {
        console.error(`prepare [${myId}] error:`, e);
        if (myId === prepareIdRef.current) {
          Alert.alert('Error', 'Failed to prepare audio: ' + e.message);
        }
      } finally {
        if (myId === prepareIdRef.current) setPreparing(false);
      }
    };

    doPrepare();

    return () => { cancelled = true; };
  }, [scoreData, appliedPresetIndex]);

  /* ── Phase 2: Voice selection changes ── */
  /* Web Audio: voice selection is applied at play-time.                        */
  /* Legacy WAV fallback: do not regenerate from UI interaction.                */
  useEffect(() => {
    if (!scoreData) return;
    if (webAudioReadyRef.current) {
      // Web Audio path: voice selection is applied at play time, nothing to do
      // If currently playing, reschedule with new voice selection
      if (AudioPlaybackService.isPlaying) {
        // Try native bridge first
        const nativeBridge = nativeAudioBridgeRef.current;
        if (nativeBridge?.isAvailable && nativeBridge?.isPlaying) {
          try {
            console.log(`[Native] Updating tempo to ${tempo} BPM`);
            nativeBridge.setTempo(tempo).catch((e) => {
              console.warn('Native bridge tempo update failed, using JS:', e.message);
              AudioPlaybackService.changeTempo(tempo, playbackVoiceSelection);
            });
          } catch (e) {
            console.warn('Native bridge error:', e.message);
            AudioPlaybackService.changeTempo(tempo, playbackVoiceSelection);
          }
        } else {
          AudioPlaybackService.changeTempo(tempo, playbackVoiceSelection);
        }
      }
    } else if (AudioPlaybackService.isPlaying) {
      console.log('ℹ️ Voice selection changed during WAV playback; changes apply on next play session.');
    };
  }, [playbackVoiceSelection, tempo]);

  /** Mix pre-rendered voice buffers into a single WAV based on effective voice selection */
  const doMix = async (myId, selectionOverride = playbackVoiceSelection, statusText = 'Preparing audio...') => {
    audioFileUriRef.current = null;
    mixedVoiceSelectionKeyRef.current = '';
    setPreparing(true);
    setPreparingStatusText(statusText);
    try {
      // Check at least one voice has notes
      const activeVoices = Object.entries(selectionOverride || {})
        .filter(([, v]) => v).map(([k]) => k);
      console.log(`🎵 mix [${myId}]: voices=${activeVoices.join(',')}`);

      const { fileUri, timingMap, totalDuration: dur } =
        await AudioPlaybackService.mixVoiceTracks(selectionOverride);

      if (myId !== prepareIdRef.current) {
        console.log(`🎵 mix [${myId}]: stale, abandoning`);
        return;
      }

      if (!fileUri || !timingMap.length || dur <= 0) {
        Alert.alert('No playable notes', 'No notes detected for playback.');
        audioFileUriRef.current = null;
        setTotalDuration(0);
        setPreparing(false);
        return;
      }

      audioFileUriRef.current = fileUri;
      mixedVoiceSelectionKeyRef.current = getVoiceSelectionKey(selectionOverride);
      setTotalDuration(dur);
      setPlaybackTime(0);

      console.log(`✅ Audio ready [${myId}]: ${dur.toFixed(1)}s, file=${fileUri ? 'OK' : 'MISSING'}`);
      return true;
    } catch (e) {
      console.error(`mix [${myId}] error:`, e);
      if (myId === prepareIdRef.current) {
        audioFileUriRef.current = null;
        Alert.alert('Error', 'Failed to mix audio: ' + e.message);
      }
      return false;
    } finally {
      if (myId === prepareIdRef.current) {
        setPreparing(false);
        setPreparingStatusText('');
      }
    }
  };

  const ensureFallbackRenderReadyForPlay = async (myId) => {
    const desiredRenderSignature = `${appliedPresetIndex}|${Math.round(pitchHz * 10)}|${tempo}`;
    const needsPreRender = !fallbackWavPreparedRef.current || fallbackRenderSignatureRef.current !== desiredRenderSignature;
    if (!needsPreRender) return true;

    const playbackNotes = getLiteralPlaybackNotes(scoreData);
    setPreparing(true);
    setPreparingStatusText('Applying tempo/pitch...');
    try {
      const preRender = await AudioPlaybackService.preRenderVoiceTracks(playbackNotes, tempo, {
        measureBeats: scoreData?.metadata?.measureBeats,
      });

      if (myId !== prepareIdRef.current) {
        return false;
      }

      if (!preRender) {
        Alert.alert('Not Ready', 'Could not prepare audio for current tempo/pitch.');
        return false;
      }

      fallbackWavPreparedRef.current = true;
      fallbackRenderSignatureRef.current = desiredRenderSignature;
      mixedVoiceSelectionKeyRef.current = '';
      return true;
    } finally {
      if (myId === prepareIdRef.current) {
        setPreparing(false);
        setPreparingStatusText('');
      }
    }
  };

  /* ── Playback controls ── */
  const handlePlay = async () => {
    if (preparing || playPressLockRef.current) return;
    playPressLockRef.current = true;
    setPlayPending(true);

    try {
    AudioPlaybackService.setExternalBeatGuideOnsets(sharedBeatOffsetsForAudio, {
      measureBeats: scoreData?.metadata?.measureBeats,
      totalBeats: graphTotalBeats > 0 ? graphTotalBeats : preparedTotalBeats,
    });

    if (isPaused) {
      transportAnchorSecRef.current = playbackTime;
      transportAnchorTsRef.current = Date.now();
      
      // Try native bridge first if available and playing
      const nativeBridge = nativeAudioBridgeRef.current;
      if (nativeBridge?.isAvailable && nativeBridge?.isPaused) {
        try {
          await nativeBridge.resume();
          setIsPlaying(true);
          setIsPaused(false);
          return;
        } catch (e) {
          console.warn('Native bridge resume failed, falling back to JS:', e.message);
        }
      }
      
      await AudioPlaybackService.resume(playbackVoiceSelection);
      setIsPlaying(true);
      setIsPaused(false);
      return;
    }

    setIsPaused(false);
    setPlaybackTime(0);
    lastPlaybackUiUpdateRef.current = 0;
    lastVisualTimeRef.current = 0;
    transportAnchorSecRef.current = 0;
    transportAnchorTsRef.current = Date.now();
    renderedScoreRef.current?.resetPlayback?.();

    // 🎵 Try native audio bridge first (super player)
    const nativeBridge = nativeAudioBridgeRef.current;
    if (nativeBridge?.isAvailable) {
      try {
        console.log(`🚀 handlePlay: Native Audio Bridge at ${tempo} BPM`);
        
        // Prepare notes with timing info
        const notes = rawNoteEventsRef.current.map((note) => ({
          pitch: note.midiPitch,
          velocity: 100,
          startTimeMs: (note.beatOnsetPos * 60000) / tempo,
          durationMs: (note.beatDurationPos * 60000) / tempo,
        }));

        // Play via native bridge
        await nativeBridge.play(notes, { sampleRate: 48000 });
        
        // Set up callbacks for page updates
        const onFinished = () => {
          setIsPlaying(false);
          setIsPaused(false);
          updatePlaybackPosition(totalDuration, true);
        };
        nativeBridge.onStatusChange((status, data) => {
          if (status === 'STOPPED' || status === 'ERROR') {
            onFinished();
          }
        });

        setIsPlaying(true);
        transportAnchorSecRef.current = 0;
        transportAnchorTsRef.current = Date.now();
        return;
      } catch (e) {
        console.warn('Native bridge play failed:', e.message, '— falling back to JS audio');
      }
    }

    if (webAudioReadyRef.current) {
      // Web Audio path: schedule all notes, no file needed
      console.log(`▶️ handlePlay: Web Audio at ${tempo} BPM`);
      AudioPlaybackService._onFinished = () => {
        setIsPlaying(false);
        setIsPaused(false);
        updatePlaybackPosition(totalDuration, true);
      };
      AudioPlaybackService.playWebAudio(tempo, playbackVoiceSelection,
        null,
        () => { setIsPlaying(false); setIsPaused(false); updatePlaybackPosition(totalDuration, true); }
      );
      setIsPlaying(true);
      return;
    }

    const preRenderId = ++prepareIdRef.current;
    const fallbackReady = await ensureFallbackRenderReadyForPlay(preRenderId);
    if (!fallbackReady) {
      setIsPlaying(false);
      return;
    }

    const desiredVoiceSelectionKey = getVoiceSelectionKey(playbackVoiceSelection);
    if (desiredVoiceSelectionKey !== mixedVoiceSelectionKeyRef.current) {
      const voiceLabel = getSelectedVoiceNames(playbackVoiceSelection);
      const myId = ++prepareIdRef.current;
      const mixed = await doMix(myId, playbackVoiceSelection, `Detecting ${voiceLabel}...`);
      if (!mixed || !audioFileUriRef.current) {
        setIsPlaying(false);
        return;
      }
    }

    // Non-WebAudio transport path: play pre-rendered file via expo-av
    if (!audioFileUriRef.current) {
      console.warn('handlePlay: audioFileUriRef is null');
      Alert.alert('Not Ready', 'Audio is still preparing. Please wait.');
      setIsPlaying(false);
      return;
    }
    const fileUri = audioFileUriRef.current;
    console.log(`▶️ handlePlay: playing ${fileUri}`);
    try {
      await AudioPlaybackService.play(
        fileUri,
        (timeSec) => {
          if (!Number.isFinite(timeSec)) return;
          const next = Math.max(0, timeSec);
          if (next + 0.06 < transportAnchorSecRef.current) return;
          transportAnchorSecRef.current = Math.max(transportAnchorSecRef.current, next);
          transportAnchorTsRef.current = Date.now();
        },
        () => { setIsPlaying(false); setIsPaused(false); updatePlaybackPosition(totalDuration, true); }
      );
      setIsPlaying(true);
    } catch (e) {
      console.error('Play error:', e);
      setIsPlaying(false);
    }
    } finally {
      playPressLockRef.current = false;
      setPlayPending(false);
    }
  };

  const handlePause = async () => {
    const nativeBridge = nativeAudioBridgeRef.current;
    if (nativeBridge?.isAvailable && nativeBridge?.isPlaying) {
      try {
        await nativeBridge.pause();
      } catch (e) {
        console.warn('Native bridge pause failed:', e.message);
      }
    }
    
    await AudioPlaybackService.pause();
    transportAnchorSecRef.current = playbackTime;
    transportAnchorTsRef.current = Date.now();
    setIsPlaying(false);
    setIsPaused(true);
  };

  const handleStop = async () => {
    const nativeBridge = nativeAudioBridgeRef.current;
    if (nativeBridge?.isAvailable && nativeBridge?.isPlaying) {
      try {
        await nativeBridge.stop();
      } catch (e) {
        console.warn('Native bridge stop failed:', e.message);
      }
    }
    
    await AudioPlaybackService.stop();
    setIsPlaying(false);
    setIsPaused(false);
    setPlaybackTime(0);
    lastVisualTimeRef.current = 0;
    transportAnchorSecRef.current = 0;
    transportAnchorTsRef.current = 0;
    renderedScoreRef.current?.resetPlayback?.();
  };

  const handleSeek = async (timeSec) => {
    if (isPlaying) {
      await AudioPlaybackService.pause();
      setIsPlaying(false);
      setIsPaused(true);
    }

    AudioPlaybackService.setExternalBeatGuideOnsets(sharedBeatOffsetsForAudio, {
      measureBeats: scoreData?.metadata?.measureBeats,
      totalBeats: graphTotalBeats > 0 ? graphTotalBeats : preparedTotalBeats,
    });
    const clamped = Math.max(0, Math.min(timeSec, totalDuration));
    transportAnchorSecRef.current = clamped;
    transportAnchorTsRef.current = Date.now();
    const renderedTotal = graphTotalDuration > 0 ? graphTotalDuration : totalDuration;
    const seekVisualLead = RENDER_VISUAL_LEAD_MS / 1000;
    lastVisualTimeRef.current = Math.max(
      0,
      Math.min(clamped + seekVisualLead, renderedTotal > 0 ? renderedTotal : clamped + seekVisualLead)
    );
    setPlaybackTime(clamped);

    const beatTotalForRender = playbackTotalBeats;
    if (beatTotalForRender > 0) {
      const beat = clamped / (60 / tempo);
      renderedScoreRef.current?.syncBeat?.(beat, beatTotalForRender);
    } else {
      renderedScoreRef.current?.syncPlayback?.(clamped, totalDuration);
    }
    await AudioPlaybackService.seekTo(clamped, playbackVoiceSelection);
  };

  const toggleVoice = (voice) => {
    // Stop playback so audio re-prepares with new voice selection
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    mixedVoiceSelectionKeyRef.current = '';
    updateVoiceSelectionForClef((prev) => {
      const next = { ...prev, [voice]: !prev[voice] };
      if (!Object.values(next).some(Boolean)) {
        Alert.alert('Select Voice', 'At least one voice must be selected');
        return prev;
      }
      return next;
    });
  };

  const soloVoice = (voice) => {
    // Stop playback so audio re-prepares
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    mixedVoiceSelectionKeyRef.current = '';
    updateVoiceSelectionForClef((prev) => {
      const activeCount = Object.values(prev).filter(Boolean).length;
      const onlyThisActive = prev[voice] && activeCount === 1;

      if (onlyThisActive) {
        // Already solo'd on this voice — re-enable all
        console.log(`🎤 unsolo ${voice} → all voices on`);
        return { Soprano: true, Alto: true, Tenor: true, Bass: true };
      }

      // Solo this voice (deactivate all others)
      console.log(`🎤 solo ${voice}`);
      return {
        Soprano: voice === 'Soprano',
        Alto: voice === 'Alto',
        Tenor: voice === 'Tenor',
        Bass: voice === 'Bass',
      };
    });
  };

  const allVoicesOn = () => {
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    mixedVoiceSelectionKeyRef.current = '';
    commitVoiceSelection({ Soprano: true, Alto: true, Tenor: true, Bass: true });
  };

  /* ── Instrument selection ── */
  const handleSelectInstrument = (presetIndex) => {
    if (isPlaying) return;
    setSelectedPresetIndex(presetIndex);
    // Close the picker quickly for UX, but debounce the expensive apply.
    setShowInstrumentPicker(false);
    setIsApplyingPreset(true);
    if (_applyTimerRef.current) {
      clearTimeout(_applyTimerRef.current);
    }
    _applyTimerRef.current = setTimeout(() => {
      setAppliedPresetIndex(presetIndex);
      setIsApplyingPreset(false);
      _applyTimerRef.current = null;
    }, 400);
  };

  const handleExportMusicXml = async () => {
    const musicXml = scoreData?.musicXml;
    if (!musicXml || musicXml.length < 20) {
      Alert.alert('No MusicXML', 'This scan result does not include exportable MusicXML. Please rescan the score.');
      return;
    }

    try {
      const titleBase = (scoreData?.metadata?.title || 'notescan_score')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50) || 'notescan_score';

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${titleBase}_${stamp}.musicxml`;
      const file = new File(Paths.document, fileName);

      file.write(musicXml);

      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Exported', `Saved MusicXML to: ${file.uri}`);
        return;
      }

      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/vnd.recordare.musicxml+xml',
        dialogTitle: 'Export MusicXML',
        UTI: 'public.xml',
      });
    } catch (e) {
      console.error('MusicXML export failed:', e);
      Alert.alert('Export failed', e?.message || 'Could not export MusicXML file.');
    }
  };

  const handleExportWav = async () => {
    if (!scoreData?.notes?.length) {
      Alert.alert('No score data', 'No notes detected for WAV export. Please rescan the score.');
      return;
    }

    const playbackNotes = getLiteralPlaybackNotes(scoreData);

    try {
      setPreparing(true);
      setPreparingStatusText('Preparing WAV export...');
      await AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);

      const preRender = await AudioPlaybackService.preRenderVoiceTracks(playbackNotes, tempo, {
        measureBeats: scoreData?.metadata?.measureBeats,
      });
      if (!preRender) {
        throw new Error('Cannot export WAV because beatOffset timing data is unavailable.');
      }

      const { fileUri } = await AudioPlaybackService.mixVoiceTracks(effectiveVoiceSelection);
      if (!fileUri) {
        throw new Error('WAV export failed to produce an output file.');
      }

      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Exported', `Saved WAV to: ${fileUri}`);
        return;
      }

      await Sharing.shareAsync(fileUri, {
        mimeType: 'audio/wav',
        dialogTitle: 'Export WAV',
        UTI: 'com.microsoft.waveform-audio',
      });
    } catch (e) {
      console.error('WAV export failed:', e);
      Alert.alert('Export failed', e?.message || 'Could not export WAV file.');
    } finally {
      setPreparing(false);
      setPreparingStatusText('');
    }
  };

  const handleExportSatbMusicXml = async () => {
    if (!scoreData?.notes?.length) {
      Alert.alert('No score data', 'No notes detected for SATB export. Please rescan the score.');
      return;
    }

    try {
      setPreparing(true);
      setPreparingStatusText('Preparing SATB export...');
      await AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);

      const playbackNotes = getLiteralPlaybackNotes(scoreData);
      const prepared = AudioPlaybackService.prepareNoteEvents(playbackNotes, {
        measureBeats: scoreData?.metadata?.measureBeats,
      });
      if (!prepared || !prepared.noteEvents) {
        throw new Error('Cannot prepare note events for SATB export (timing data unavailable).');
      }

      const { noteEvents, timingBeatData } = prepared;
      const { xml, report } = separateSATBFromEvents(noteEvents, timingBeatData || []);
      if (!xml) throw new Error('SATB export produced no output.');

      const titleBase = (scoreData?.metadata?.title || 'notescan_score')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50) || 'notescan_score';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${titleBase}_SATB_${stamp}.musicxml`;
      const file = new File(Paths.document, fileName);

      await file.write(xml);

      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Exported', `Saved SATB MusicXML to: ${file.uri}`);
        return;
      }

      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/vnd.recordare.musicxml+xml',
        dialogTitle: 'Export SATB MusicXML',
        UTI: 'public.xml',
      });

      Alert.alert('SATB Exported', `Measures processed: ${report.measuresProcessed}`);
    } catch (e) {
      console.error('SATB export failed:', e);
      Alert.alert('Export failed', e?.message || 'Could not export SATB MusicXML file.');
    } finally {
      setPreparing(false);
      setPreparingStatusText('');
    }
  };

  const currentInstrumentName =
    availablePresets.find((preset) => preset.index === appliedPresetIndex)?.name || 'Piano';
  const instrumentStatusLabel = `${currentInstrumentName} (${selectedSoundFontKey}${loadingSoundFontKey ? ' loading' : ''})`;
  const pitchShiftLabel = `${Math.round(pitchHz)} Hz`;
  const livePitchShiftLabel = `${Math.round(pitchSliderHz)} Hz`;
  const selectedPitchPipe = PITCH_PIPE_NOTES[pitchPipeIndex] || PITCH_PIPE_NOTES[9];
  const pitchPipeWheelPoints = useMemo(() => {
    const wheelSize = 280;
    const center = wheelSize / 2;
    const radius = 106;
    return PITCH_PIPE_NOTES.map((note, idx) => {
      const angleDeg = -90 + idx * (360 / PITCH_PIPE_NOTES.length);
      const angle = (angleDeg * Math.PI) / 180;
      return {
        idx,
        note,
        left: center + radius * Math.cos(angle),
        top: center + radius * Math.sin(angle),
      };
    });
  }, []);
  const timepointGraph = useMemo(() => {
    return Array.isArray(preparedTimepointGraph) ? preparedTimepointGraph : [];
  }, [preparedTimepointGraph]);
  const graphTotalBeats = useMemo(() => {
    if (!Array.isArray(timepointGraph) || timepointGraph.length === 0) return 0;
    let maxBeat = 0;
    for (const tp of timepointGraph) {
      const base = Number.isFinite(tp?.beatOffset) ? tp.beatOffset : 0;
      const barEnd = Number.isFinite(tp?.barEndBeat) ? tp.barEndBeat : null;
      maxBeat = Math.max(maxBeat, base);
      if (Number.isFinite(barEnd)) {
        maxBeat = Math.max(maxBeat, barEnd);
      }
    }
    return maxBeat;
  }, [timepointGraph]);
  const graphTotalDuration = useMemo(() => {
    if (!Number.isFinite(graphTotalBeats) || graphTotalBeats <= 0) return 0;
    return graphTotalBeats * (60 / tempo);
  }, [graphTotalBeats, tempo]);
  const playbackTotalBeats = useMemo(() => {
    if (Number.isFinite(totalDuration) && totalDuration > 0 && Number.isFinite(tempo) && tempo > 0) {
      return totalDuration / (60 / tempo);
    }
    if (Number.isFinite(preparedTotalBeats) && preparedTotalBeats > 0) {
      return preparedTotalBeats;
    }
    if (Number.isFinite(graphTotalBeats) && graphTotalBeats > 0) {
      return graphTotalBeats;
    }
    return 0;
  }, [totalDuration, tempo, preparedTotalBeats, graphTotalBeats]);
  const sharedBeatOffsets = useMemo(() => {
    if (!Array.isArray(timepointGraph) || timepointGraph.length === 0) return [];
    return timepointGraph
      .filter((tp) => (tp.sounds || []).some((s) => isVoiceAllowed(effectiveVoiceSelection, s.voice)))
      .map((tp) => tp.beatOffset)
      .sort((a, b) => a - b);
  }, [timepointGraph, effectiveVoiceSelection]);
  const highlightBuckets = useMemo(() => {
    if (!Array.isArray(timepointGraph) || timepointGraph.length === 0) return [];
    return timepointGraph
      .map((tp) => {
        const ids = [];
        for (const s of tp.sounds || []) {
          if (!s.elementId) continue;
          if (!isVoiceAllowed(effectiveVoiceSelection, s.voice)) continue;
          if (!ids.includes(s.elementId)) ids.push(s.elementId);
        }
        return { beatOffset: tp.beatOffset, elementIds: ids };
      })
      .filter((bucket) => Number.isFinite(bucket.beatOffset) && bucket.elementIds.length > 0)
      .sort((a, b) => a.beatOffset - b.beatOffset);
  }, [timepointGraph, effectiveVoiceSelection]);
  const sharedBeatOffsetsForAudio = useMemo(() => {
    return highlightBuckets.map((bucket) => bucket.beatOffset);
  }, [highlightBuckets]);

  useEffect(() => {
    AudioPlaybackService.setExternalBeatGuideOnsets(sharedBeatOffsetsForAudio, {
      measureBeats: scoreData?.metadata?.measureBeats,
      totalBeats: graphTotalBeats > 0 ? graphTotalBeats : preparedTotalBeats,
    });
  }, [sharedBeatOffsetsForAudio, scoreData, preparedTotalBeats, graphTotalBeats]);

  useEffect(() => {
    setPitchPipeIndex(getNearestPitchPipeIndex(pitchSliderHz));
  }, [pitchSliderHz]);

  const applyPitchPipeIndex = useCallback((idx) => {
    const safeIdx = Math.max(0, Math.min(PITCH_PIPE_NOTES.length - 1, idx));
    const note = PITCH_PIPE_NOTES[safeIdx];
    if (!note) return;
    AudioPlaybackService.playPitchPreviewHz(note.hz, { durationMs: 620, retriggerMs: 24, gain: 0.85 });
    if (note.hz === pitchHz && note.hz === pitchSliderHz) {
      setPitchPipeIndex(safeIdx);
      return;
    }
    setPitchPipeIndex(safeIdx);
    setPitchSliderHz(note.hz);
    setPitchHz(note.hz);
  }, [pitchHz, pitchSliderHz]);

  useEffect(() => {
    const beatTotalForRender = playbackTotalBeats;
    if (!renderedScoreRef.current?.setHighlightBuckets) return;
    renderedScoreRef.current.setHighlightBuckets(highlightBuckets, beatTotalForRender);
  }, [highlightBuckets, playbackTotalBeats]);

  const updatePlaybackPosition = useCallback((timeSec, force = false) => {
    const audioTotal = totalDuration || timeSec || 0;
    const clamped = Math.max(0, Math.min(timeSec, audioTotal));
    const renderedTotal = graphTotalDuration > 0 ? graphTotalDuration : totalDuration;
    const atAudioEnd = audioTotal > 0 && clamped >= audioTotal - 0.02;
    const renderBaseTime =
      force && atAudioEnd && renderedTotal > 0
        ? renderedTotal
        : Math.max(0, Math.min(timeSec, renderedTotal || timeSec || 0));
    const visualLeadSec = RENDER_VISUAL_LEAD_MS / 1000;
    const visualTimeSecRaw = Math.max(
      0,
      Math.min(
        renderBaseTime + visualLeadSec,
        renderedTotal > 0 ? renderedTotal : (renderBaseTime + visualLeadSec)
      )
    );
    const visualTimeSec = force
      ? visualTimeSecRaw
      : Math.max(visualTimeSecRaw, lastVisualTimeRef.current);
    lastVisualTimeRef.current = visualTimeSec;
    const secondsPerBeat = 60 / tempo;
    const beatForRender = visualTimeSec / secondsPerBeat;

    const beatTotalForRender = playbackTotalBeats;
    if (renderedScoreRef.current?.syncBeat && beatTotalForRender > 0) {
      renderedScoreRef.current.syncBeat(beatForRender, beatTotalForRender);
    } else if (renderedScoreRef.current?.syncPlayback && renderedTotal > 0) {
      renderedScoreRef.current.syncPlayback(visualTimeSec, renderedTotal);
    }

    const now = Date.now();
    if (force || now - lastPlaybackUiUpdateRef.current >= PLAYBACK_UI_UPDATE_MS) {
      lastPlaybackUiUpdateRef.current = now;
      setPlaybackTime(clamped);
    }
  }, [
    totalDuration,
    graphTotalDuration,
    tempo,
    playbackTotalBeats,
  ]);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = null;

    const tick = () => {
      if (!AudioPlaybackService.isPlaying) {
        frame = requestAnimationFrame(tick);
        return;
      }

      let timeSec = 0;
      if (webAudioReadyRef.current) {
        timeSec = AudioPlaybackService.getPlaybackPositionSec();
      } else {
        const base = transportAnchorSecRef.current;
        const anchorTs = transportAnchorTsRef.current;
        const dtSec = anchorTs > 0
          ? Math.min(0.35, Math.max(0, (Date.now() - anchorTs) / 1000))
          : 0;
        timeSec = base + dtSec;
      }

      if (Number.isFinite(timeSec)) {
        updatePlaybackPosition(timeSec);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [isPlaying, updatePlaybackPosition]);

  // Compute current beat from the prepared rule-based event timeline.
  const currentBeat = playbackTime / (60 / tempo);
  
  // Prefer graph-driven progress when available; otherwise fall back to audio duration.
  const renderProgress = (graphTotalDuration > 0)
    ? Math.min(1, playbackTime / graphTotalDuration)
    : (totalDuration > 0 ? Math.min(1, playbackTime / totalDuration) : 0);
  const renderedProgressProp = isPlaying ? Number.NaN : renderProgress;
  const seekMaxDuration = (Number.isFinite(totalDuration) && totalDuration > 0)
    ? totalDuration
    : ((Number.isFinite(graphTotalDuration) && graphTotalDuration > 0) ? graphTotalDuration : 0);
  const seekDisplayTime = isSeekSliding ? seekSliderValue : playbackTime;
  const seekSliderRenderValue = isSeekSliding ? seekSliderValue : playbackTime;

  const previewSeekCursor = useCallback((previewTimeSec) => {
    if (scoreViewMode !== 'rendered') return;
    if (!Number.isFinite(previewTimeSec)) return;

    const renderedTotal = graphTotalDuration > 0 ? graphTotalDuration : totalDuration;
    const clamped = Math.max(0, Math.min(previewTimeSec, renderedTotal > 0 ? renderedTotal : previewTimeSec));
    const beatTotalForRender = playbackTotalBeats;

    if (beatTotalForRender > 0) {
      const beat = clamped / (60 / tempo);
      renderedScoreRef.current?.syncBeat?.(beat, beatTotalForRender);
    } else if (renderedTotal > 0) {
      renderedScoreRef.current?.syncPlayback?.(clamped, renderedTotal);
    }
  }, [scoreViewMode, graphTotalDuration, totalDuration, playbackTotalBeats, tempo]);

  /* ── Render ── */
  if (processing) {
    const barWidth = loadingBarAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 188],
    });

    return (
      <View style={[styles.centerContainer, { backgroundColor: theme.background }]}>
        <StatusBar barStyle={getStatusBarStyleForTheme({ colors: theme })} backgroundColor={theme.background} />
        <View style={styles.loadingLogoWrap}>
          <WebView
            originWhitelist={["*"]}
            source={{ html: loadingEyeHtml }}
            style={styles.loadingLogoWebView}
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          />
        </View>

        <Text style={[styles.scanningText, { color: theme.ink }]}>Scanning...</Text>
        <Text style={[styles.scanningFileText, { color: theme.inkMuted }]}>{scanningFileName}</Text>
        {processingStage && (
          <Text style={[styles.processingStageText, { color: theme.inkMuted }]}>{processingStage}</Text>
        )}

        <View style={[styles.loadingBarTrack, { backgroundColor: theme.border }]}>
          <Animated.View style={[styles.loadingBarPulse, { width: barWidth }]} />
        </View>
        <TouchableOpacity style={[styles.cancelScanButton, { backgroundColor: theme.surfaceStrong, borderColor: theme.border }]} onPress={cancelScan}>
          <Text style={[styles.cancelScanButtonText, { color: theme.inkMuted }]}>Cancel Scan</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (scoreError || !scoreData) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: theme.background }]}>
        <StatusBar barStyle={getStatusBarStyleForTheme({ colors: theme })} backgroundColor={theme.background} />
        <Text style={[styles.errorTitle, { color: theme.ink }]}>Unable to load score</Text>
        <Text style={[styles.errorText, { color: theme.inkMuted }]}>{scoreError || 'Unknown error'}</Text>
        <TouchableOpacity style={[styles.retryButton, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={processScore}>
          <Text style={[styles.retryButtonText, { color: theme.ink }]}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.retryButton, { marginTop: 10, backgroundColor: theme.surface, borderColor: theme.border }]} onPress={onNavigateBack}>
          <Text style={[styles.retryButtonText, { color: theme.ink }]}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle={getStatusBarStyleForTheme({ colors: theme })} backgroundColor={theme.background} />

      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 16,
            paddingLeft: 24 + insets.left,
            paddingRight: 24 + insets.right,
          },
        ]}
      >
        <TouchableOpacity onPress={onNavigateBack}>
          <Text style={styles.linkText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>
          {headerTitle}
        </Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Voice controls moved to top for quick access */}
      <View style={[styles.topVoiceBar, { paddingLeft: 12 + insets.left, paddingRight: 12 + insets.right }]}>
        <View style={styles.topVoiceRow}>
          <View style={[styles.topVoicePill, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
            <Pressable
              style={({ pressed }) => [
                styles.topVoiceDot,
                {
                  backgroundColor: allVisibleVoicesSelected ? theme.surfaceStrong : theme.background,
                  borderColor: allVisibleVoicesSelected ? theme.accent : theme.border,
                },
                pressed && styles.pressedDot,
              ]}
              onPress={allVoicesOn}
            >
              <Text
                style={[
                  styles.topVoiceDotText,
                  { color: allVisibleVoicesSelected ? theme.ink : theme.inkMuted },
                ]}
              >
                All
              </Text>
            </Pressable>
            {Object.keys(voiceSelection).map((voice) => {
              const vc = scoreData?.metadata?.voiceCounts || {};
              const hasVoiceCounts = Object.keys(vc).length > 0;
              const cnt = vc[voice] || 0;
              const isEmpty = hasVoiceCounts && cnt === 0;
              const voiceLabel =
                voice === 'Soprano'
                  ? 'Soprano'
                  : voice === 'Alto'
                    ? 'Alto'
                    : voice === 'Tenor'
                      ? 'Tenor'
                      : voice === 'Bass'
                        ? 'Bass'
                        : voice;
              return (
                <Pressable
                  key={voice}
                  style={({ pressed }) => [
                    styles.topVoiceDot,
                    {
                      backgroundColor: isEmpty
                        ? theme.surface
                        : effectiveVoiceSelection[voice]
                          ? theme.surfaceStrong
                          : theme.background,
                      borderColor: isEmpty
                        ? theme.border
                        : effectiveVoiceSelection[voice]
                          ? theme.accent
                          : theme.border,
                      opacity: isEmpty ? 0.55 : 1,
                    },
                    pressed && !isEmpty && styles.pressedDot,
                  ]}
                  onPress={() => (isEmpty ? null : toggleVoice(voice))}
                  onLongPress={() => (isEmpty ? null : soloVoice(voice))}
                  disabled={isEmpty}
                >
                  <Text
                    style={[
                      styles.topVoiceDotText,
                      { color: isEmpty ? theme.inkMuted : effectiveVoiceSelection[voice] ? theme.ink : theme.inkMuted },
                    ]}
                  >
                    {voiceLabel}{isEmpty ? ' ⊘' : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            style={({ pressed }) => [
              styles.topPitchPipeButton,
              {
                backgroundColor: theme.surface,
                borderColor: showPitchPipeModal ? theme.accent : theme.border,
              },
              pressed && styles.pressedPill,
            ]}
            onPress={() => setShowPitchPipeModal(true)}
          >
            <Image
              source={require('../../assets/pitch_pipe_dark.gif')}
              style={{ width: 38, height: 38 }}
            />
          </Pressable>
        </View>
      </View>

      {/* Score view */}
      <View style={[styles.viewerArea, { marginLeft: 12 + insets.left, marginRight: 12 + insets.right, backgroundColor: theme.surface, borderColor: theme.border }]}> 
        {scoreViewMode === 'rendered' ? (
          <RenderedScoreView
            ref={renderedScoreRef}
            musicXml={scoreData?.musicXml || ''}
            currentBeat={renderedProgressProp}
            playheadMode={renderedPlayheadMode}
            playheadColor={RENDERED_LINE_COLORS[renderedLineColorIdx]}
            playheadNoteColor={RENDERED_NOTE_COLORS[renderedNoteColorIdx]}
            renderViewPreset={renderViewPreset}
            showControlBar={false}
            onSeekNormalizedBeat={(normalizedBeat) => {
              if (!Number.isFinite(normalizedBeat)) return;
              const seekTotal = Number.isFinite(totalDuration) && totalDuration > 0
                ? totalDuration
                : (Number.isFinite(graphTotalDuration) && graphTotalDuration > 0 ? graphTotalDuration : 0);
              if (seekTotal <= 0) return;
              handleSeek(normalizedBeat * seekTotal);
            }}
            onPlayheadModeChange={setRenderedPlayheadMode}
            onRenderViewPresetChange={setRenderViewPreset}
            onPlayheadColorChange={(color) => {
              const idx = RENDERED_LINE_COLORS.indexOf(color);
              if (idx >= 0) {
                setRenderedLineColorIdx(idx);
              }
            }}
            onPlayheadNoteColorChange={(color) => {
              const idx = RENDERED_NOTE_COLORS.indexOf(color);
              if (idx >= 0) {
                setRenderedNoteColorIdx(idx);
              }
            }}
          />
        ) : (
          <PlaybackVisualization
            imageUri={scoreData?.processedImageUri || imageUri}
            currentTime={playbackTime}
            totalDuration={totalDuration}
            isPlaying={isPlaying}
            cursorInfo={null}
            onSeek={handleSeek}
            measureBeats={scoreData?.metadata?.measureBeats}
            tempo={tempo}
            pitchTimeline={ENABLE_PITCH_VIEW ? pitchTimeline : []}
            voiceSelection={voiceSelection}
            debugNotes={scoreData?.notes}
            timelineMode={AUDIO_TIMELINE_MODE}
            theme={theme}
          />
        )}
      </View>

      {/* Combined Tempo + Pitch modal */}
      <Modal
        visible={showAudioControls}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAudioControls(false)}
      >
        <View style={styles.audioControlsOverlay}>
          <View style={[styles.audioControlsPanel, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={[styles.audioControlsHeader, { borderBottomColor: theme.border }]}>
              <Text style={[styles.audioControlsTitle, { color: theme.ink }]}>Audio Control</Text>
              <TouchableOpacity onPress={() => setShowAudioControls(false)} style={[styles.audioControlsCloseButton, { backgroundColor: theme.surfaceStrong, borderColor: theme.border }]}>
                <Feather name="x" size={20} color={theme.ink} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={styles.audioControlsScroll}>
              {/* Tempo Control */}
              <View style={[styles.audioControlBlock, { backgroundColor: theme.surfaceStrong, borderColor: theme.border, borderLeftColor: theme.accent }]}>
                <View style={styles.audioControlRow}>
                  <Text style={[styles.audioControlLabel, { color: theme.inkMuted }]}>Tempo</Text>
                  <Text style={[styles.audioControlValue, { color: theme.ink }]}>♩ = {sliderTempo}</Text>
                </View>
                <Slider
                  style={styles.audioSlider}
                  minimumValue={40}
                  maximumValue={240}
                  step={1}
                  value={sliderTempo}
                  onValueChange={(v) => {
                    const bpm = Math.round(v);
                    setSliderTempo(bpm);
                    if (isPlaying && webAudioReadyRef.current) {
                      setTempo(bpm);
                      const nativeBridge = nativeAudioBridgeRef.current;
                      if (nativeBridge?.isAvailable && nativeBridge?.isPlaying) {
                        try {
                          console.log(`[Native] Tempo slider → ${bpm} BPM`);
                          nativeBridge.setTempo(bpm).catch((e) => {
                            console.warn('Native tempo change failed, using JS:', e.message);
                            const result = AudioPlaybackService.changeTempo(bpm, playbackVoiceSelection);
                            if (result) {
                              setTotalDuration(result.totalDuration);
                              setPitchTimeline(
                                ENABLE_PITCH_VIEW
                                  ? buildPitchTimelineFromRawEvents(rawNoteEventsRef.current, bpm)
                                  : []
                              );
                            }
                          });
                        } catch (e) {
                          console.warn('Native bridge error:', e.message);
                          const result = AudioPlaybackService.changeTempo(bpm, playbackVoiceSelection);
                          if (result) {
                            setTotalDuration(result.totalDuration);
                            setPitchTimeline(
                              ENABLE_PITCH_VIEW
                                ? buildPitchTimelineFromRawEvents(rawNoteEventsRef.current, bpm)
                                : []
                            );
                          }
                        }
                      } else {
                        const result = AudioPlaybackService.changeTempo(bpm, playbackVoiceSelection);
                        if (result) {
                          setTotalDuration(result.totalDuration);
                          setPitchTimeline(
                            ENABLE_PITCH_VIEW
                              ? buildPitchTimelineFromRawEvents(rawNoteEventsRef.current, bpm)
                              : []
                          );
                        }
                      }
                    }
                  }}
                  onSlidingComplete={(v) => {
                    const bpm = Math.round(v);
                    setSliderTempo(bpm);
                    setTempo(bpm);
                    if (isPlaying && webAudioReadyRef.current) {
                      const result = AudioPlaybackService.changeTempo(bpm, playbackVoiceSelection);
                      if (result) {
                        setTotalDuration(result.totalDuration);
                        setPitchTimeline(
                          ENABLE_PITCH_VIEW
                            ? buildPitchTimelineFromRawEvents(rawNoteEventsRef.current, bpm)
                            : []
                        );
                      }
                    }
                  }}
                  minimumTrackTintColor={theme.accent}
                  maximumTrackTintColor={theme.border}
                  thumbTintColor={theme.accent}
                />
              </View>

              {/* Pitch Control */}
              <View style={[styles.audioControlBlock, { backgroundColor: theme.surfaceStrong, borderColor: theme.border, borderLeftColor: theme.accent }]}>
                <View style={styles.audioControlRow}>
                  <Text style={[styles.audioControlLabel, { color: theme.inkMuted }]}>Pitch Ref</Text>
                  <Text style={[styles.audioControlValue, { color: theme.ink }]}>{livePitchShiftLabel}</Text>
                </View>
                <Slider
                  style={styles.audioSlider}
                  minimumValue={PITCH_PIPE_MIN_HZ}
                  maximumValue={PITCH_PIPE_MAX_HZ}
                  step={1}
                  value={pitchSliderHz}
                  onValueChange={(v) => {
                    const nextHz = Math.max(PITCH_PIPE_MIN_HZ, Math.min(PITCH_PIPE_MAX_HZ, Math.round(v)));
                    setPitchSliderHz(nextHz);
                    if (isPlaying && webAudioReadyRef.current) {
                      setPitchHz(nextHz);
                    }
                  }}
                  onSlidingComplete={(v) => {
                    const nextHz = Math.max(PITCH_PIPE_MIN_HZ, Math.min(PITCH_PIPE_MAX_HZ, Math.round(v)));
                    setPitchSliderHz(nextHz);
                    if (nextHz !== pitchHz) {
                      setPitchHz(nextHz);
                    }
                  }}
                  minimumTrackTintColor={theme.accent}
                  maximumTrackTintColor={theme.border}
                  thumbTintColor={theme.accent}
                />
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Timeline seek slider */}
      <View
        style={[
          styles.seekBarWrap,
          !showTimeline && styles.seekBarWrapCollapsed,
          { paddingLeft: 14 + insets.left, paddingRight: 14 + insets.right },
        ]}
      >
        <Pressable
          style={({ pressed }) => [styles.seekBarHeader, !showTimeline && styles.seekBarHeaderCollapsed, pressed && styles.pressedPill]}
          onPress={() => setShowTimeline((v) => !v)}
        >
          <Text style={styles.seekBarLabel}>Timeline</Text>
          <View style={styles.timelineHeaderRight}>
            {showTimeline && (
              <Text style={styles.seekBarTimeText}>
                {formatTime(seekDisplayTime)} / {formatTime(seekMaxDuration)}
              </Text>
            )}
            <Feather
              name={showTimeline ? 'chevron-down' : 'chevron-up'}
              size={20}
              color={barPalette.barTextMuted}
            />
          </View>
        </Pressable>
        {showTimeline && (
          <Slider
            style={styles.seekSlider}
            minimumValue={0}
            maximumValue={Math.max(0.001, seekMaxDuration)}
            value={Math.max(0, Math.min(seekSliderRenderValue, Math.max(0.001, seekMaxDuration)))}
            onSlidingStart={() => {
              setSeekSliderValue(Math.max(0, Math.min(playbackTime, Math.max(0.001, seekMaxDuration))));
              setIsSeekSliding(true);
              previewSeekCursor(playbackTime);
            }}
            onValueChange={(v) => {
              if (!isSeekSliding) return;
              const target = Math.max(0, Math.min(v, seekMaxDuration));
              setSeekSliderValue((prev) => (Math.abs(prev - target) > 0.005 ? target : prev));
              previewSeekCursor(target);
            }}
            onSlidingComplete={async (v) => {
              const target = Math.max(0, Math.min(v, seekMaxDuration));
              setSeekSliderValue(target);
              previewSeekCursor(target);
              if (seekMaxDuration > 0) {
                await handleSeek(target);
              }
              setIsSeekSliding(false);
            }}
            disabled={seekMaxDuration <= 0}
            minimumTrackTintColor={barPalette.accent}
            maximumTrackTintColor={barPalette.barBorder}
            thumbTintColor={barPalette.accent}
          />
        )}
      </View>

      {/* Transport bar */}
      <View
        style={[
          styles.bottomBar,
          {
            paddingBottom: insets.bottom + 16,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.barScroll}
        >
          {/* Play / Pause */}
          <Pressable
            style={({ pressed }) => [
              styles.playPill,
              isPaused && !isPlaying && styles.playPillPaused,
              pressed && styles.pressedPill,
            ]}
            onPress={isPlaying ? handlePause : handlePlay}
            disabled={preparing || playPending}
          >
            <Feather
              name={isPlaying ? 'pause' : 'play'}
              size={14}
              color={isPaused && !isPlaying ? barPalette.accent : barPalette.barText}
            />
            <Text style={styles.playPillText}>
              {(preparing || playPending) ? 'Preparing...' : isPlaying ? 'Pause' : isPaused ? 'Resume' : 'Play'}
            </Text>
          </Pressable>

          {/* Stop */}
          <Pressable style={({ pressed }) => [styles.iconPill, pressed && styles.pressedPill]} onPress={handleStop}>
            <Feather name="square" size={14} color={barPalette.barText} />
          </Pressable>

          {/* Audio Controls (Tempo + Pitch) */}
          <Pressable
            style={({ pressed }) => [styles.iconPill, showAudioControls && { borderColor: barPalette.accent }, pressed && styles.pressedPill]}
            onPress={() => setShowAudioControls((v) => !v)}
          >
            <Feather name="sliders" size={14} color={showAudioControls ? barPalette.accent : barPalette.barText} />
          </Pressable>

          {/* Instrument selector */}
          {availablePresets.length > 0 && (
            <Pressable
              style={({ pressed }) => [
                styles.zoomPill,
                showInstrumentPicker && { borderColor: barPalette.accent },
                pressed && styles.pressedPill,
              ]}
              onPress={() => !isPlaying && setShowInstrumentPicker(true)}
              disabled={isPlaying}
            >
              <Feather name="music" size={12} color={barPalette.barTextMuted} />
              <Text style={styles.pillText} numberOfLines={1}>
                {instrumentStatusLabel}
              </Text>
            </Pressable>
          )}

          {/* Overflow controls */}
          <Pressable
            style={({ pressed }) => [styles.iconPill, showOverflowMenu && { borderColor: barPalette.accent }, pressed && styles.pressedPill]}
            onPress={() => setShowOverflowMenu(true)}
          >
            <Feather name="more-horizontal" size={15} color={barPalette.barText} />
          </Pressable>

          {/* Score info button (compact pill) */}
          <ScoreInfoPanel
            metadata={scoreData.metadata}
            currentBeat={currentBeat}
            isPlaying={isPlaying}
          />
        </ScrollView>
      </View>

      {/* Overflow menu modal */}
      <Modal
        visible={showOverflowMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOverflowMenu(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { paddingBottom: insets.bottom + 12, backgroundColor: theme.background }]}> 
            <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}> 
              <Text style={[styles.modalTitle, { color: theme.ink }]}>More Controls</Text>
              <TouchableOpacity onPress={() => setShowOverflowMenu(false)}>
                <Feather name="x" size={18} color={theme.inkMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.overflowActionsList}>
              <Pressable
                style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                onPress={() => {
                  setShowOverflowMenu(false);
                  handleExportMusicXml();
                }}
              >
                <Feather name="download" size={14} color={theme.inkMuted} />
                <Text style={[styles.overflowActionText, { color: theme.ink }]}>Export XML</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                onPress={() => {
                  setShowOverflowMenu(false);
                  handleExportWav();
                }}
              >
                <Feather name="music" size={14} color={theme.inkMuted} />
                <Text style={[styles.overflowActionText, { color: theme.ink }]}>Export WAV</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                onPress={() => {
                  setShowOverflowMenu(false);
                  handleExportSatbMusicXml();
                }}
              >
                <Feather name="users" size={14} color={theme.inkMuted} />
                <Text style={[styles.overflowActionText, { color: theme.ink }]}>Export SATB XML</Text>
              </Pressable>

              {scoreViewMode === 'rendered' && (
                <Pressable
                  style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                  onPress={() => {
                    setRenderViewPreset((preset) => (preset === 'fit' ? 'smart' : 'fit'));
                  }}
                >
                  <Feather name="maximize" size={14} color={theme.inkMuted} />
                  <Text style={[styles.overflowActionText, { color: theme.ink }]}>View preset: {renderViewPreset}</Text>
                </Pressable>
              )}

              {scoreViewMode === 'rendered' && (
                <Pressable
                  style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                  onPress={() => {
                    setRenderedPlayheadMode((mode) => {
                      const idx = RENDERED_PLAYHEAD_MODES.indexOf(mode);
                      return RENDERED_PLAYHEAD_MODES[(idx + 1) % RENDERED_PLAYHEAD_MODES.length];
                    });
                  }}
                >
                  <Feather name={renderedPlayheadMode === 'line' ? 'minus' : renderedPlayheadMode === 'both' ? 'crosshair' : 'disc'} size={14} color={theme.inkMuted} />
                  <Text style={[styles.overflowActionText, { color: theme.ink }]}>Playhead mode: {renderedPlayheadMode}</Text>
                </Pressable>
              )}

              {scoreViewMode === 'rendered' && (
                <Pressable
                  style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                  onPress={() => {
                    setRenderedLineColorIdx((idx) => (idx + 1) % RENDERED_LINE_COLORS.length);
                  }}
                >
                  <View style={[styles.overflowColorSwatch, { backgroundColor: RENDERED_LINE_COLORS[renderedLineColorIdx] === 'none' ? 'transparent' : RENDERED_LINE_COLORS[renderedLineColorIdx], borderColor: theme.border }]} />
                  <Text style={[styles.overflowActionText, { color: theme.ink }]}>Playhead line color</Text>
                </Pressable>
              )}

              {scoreViewMode === 'rendered' && (
                <Pressable
                  style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                  onPress={() => {
                    setRenderedNoteColorIdx((idx) => (idx + 1) % RENDERED_NOTE_COLORS.length);
                  }}
                >
                  <View style={[styles.overflowColorSwatch, { backgroundColor: RENDERED_NOTE_COLORS[renderedNoteColorIdx], borderColor: theme.border }]} />
                  <Text style={[styles.overflowActionText, { color: theme.ink }]}>Playhead note color</Text>
                </Pressable>
              )}

              <Pressable
                style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                onPress={() => {
                  changeClefFilter('upper');
                  setShowOverflowMenu(false);
                }}
              >
                <Feather name="arrow-up" size={14} color={theme.inkMuted} />
                <Text style={[styles.overflowActionText, { color: theme.ink }]}>Upper clef only</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                onPress={() => {
                  changeClefFilter('lower');
                  setShowOverflowMenu(false);
                }}
              >
                <Feather name="arrow-down" size={14} color={theme.inkMuted} />
                <Text style={[styles.overflowActionText, { color: theme.ink }]}>Lower clef only</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                onPress={() => {
                  setScoreViewMode((m) => (m === 'rendered' ? 'scan' : 'rendered'));
                  setShowOverflowMenu(false);
                }}
              >
                <Feather name={scoreViewMode === 'rendered' ? 'layout' : 'image'} size={14} color={theme.inkMuted} />
                <Text style={[styles.overflowActionText, { color: theme.ink }]}>{scoreViewMode === 'rendered' ? 'Switch to scanned score' : 'Switch to rendered score'}</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.overflowActionRow, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surfaceStrong : 'transparent' }]}
                onPress={() => {
                  setShowTimeline((v) => !v);
                  setShowOverflowMenu(false);
                }}
              >
                <Feather name={showTimeline ? 'eye-off' : 'eye'} size={14} color={theme.inkMuted} />
                <Text style={[styles.overflowActionText, { color: theme.ink }]}>{showTimeline ? 'Hide timeline' : 'Show timeline'}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Pitch pipe modal */}
      <Modal
        visible={showPitchPipeModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPitchPipeModal(false)}
      >
        <View style={styles.audioControlsOverlay}>
          <View style={[styles.pitchPipePanel, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
            <View style={[styles.audioControlsHeader, { borderBottomColor: theme.border }]}> 
              <Text style={[styles.audioControlsTitle, { color: theme.ink }]}>Pitch Pipe</Text>
              <TouchableOpacity onPress={() => setShowPitchPipeModal(false)} style={[styles.audioControlsCloseButton, { backgroundColor: theme.surfaceStrong, borderColor: theme.border }]}> 
                <Feather name="x" size={20} color={theme.ink} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.pitchPipeInfoText, { color: theme.inkMuted }]}>Use the pitch pipe to pitch the song from here.</Text>

            <View style={styles.pitchPipeWheel}>
              {pitchPipeWheelPoints.map((point) => {
                const isActive = point.idx === pitchPipeIndex;
                return (
                  <Pressable
                    key={point.note.label}
                    style={[
                      styles.pitchPipeNoteButton,
                      {
                        left: point.left - 19,
                        top: point.top - 19,
                        backgroundColor: isActive ? theme.accent : theme.surfaceStrong,
                        borderColor: isActive ? theme.accent : theme.border,
                      },
                    ]}
                    onPress={() => applyPitchPipeIndex(point.idx)}
                  >
                    <Text style={[styles.pitchPipeNoteLabel, { color: isActive ? '#FFF7EC' : theme.ink }]}>{point.note.label}</Text>
                  </Pressable>
                );
              })}

              <View style={[styles.pitchPipeCenter, { backgroundColor: theme.background, borderColor: theme.border }]}> 
                <Text style={[styles.pitchPipeCenterNote, { color: theme.ink }]}>{selectedPitchPipe.label}</Text>
                <Text style={[styles.pitchPipeCenterHz, { color: theme.inkMuted }]}>{selectedPitchPipe.hz} Hz</Text>
              </View>
            </View>

            <View style={[styles.pitchPipeSliderWrap, { borderColor: theme.border, backgroundColor: theme.surfaceStrong }]}> 
              <Text style={[styles.pitchPipeSliderLabel, { color: theme.inkMuted }]}>Rotate</Text>
              <Slider
                style={styles.pitchPipeSlider}
                minimumValue={0}
                maximumValue={PITCH_PIPE_NOTES.length - 1}
                step={1}
                value={pitchPipeIndex}
                onValueChange={(v) => {
                  applyPitchPipeIndex(Math.round(v));
                }}
                minimumTrackTintColor={theme.accent}
                maximumTrackTintColor={theme.border}
                thumbTintColor={theme.accent}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Instrument picker modal */}
      <Modal
        visible={showInstrumentPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowInstrumentPicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Instrument</Text>
              {isApplyingPreset && (
                <ActivityIndicator size="small" color={barPalette.accent} style={{ marginRight: 8 }} />
              )}
              <TouchableOpacity onPress={() => setShowInstrumentPicker(false)}>
                <Feather name="x" size={22} color={palette.ink} />
              </TouchableOpacity>
            </View>
            <View style={styles.soundFontSelector}>
              {SOUND_FONT_SOURCES.map((source) => {
                const active = source.key === selectedSoundFontKey;
                const loading = source.key === loadingSoundFontKey;
                return (
                  <TouchableOpacity
                    key={source.key}
                    style={[
                      styles.soundFontChip,
                      active && styles.soundFontChipActive,
                      loading && styles.soundFontChipLoading,
                    ]}
                    onPress={() => setSelectedSoundFontKey(source.key)}
                    disabled={loading}
                  >
                    <Text style={[styles.soundFontChipText, active && styles.soundFontChipTextActive]}>
                      {loading ? 'Loading…' : source.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <FlatList
              data={availablePresets}
              keyExtractor={(item) => String(item.index)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.instrumentRow,
                    item.index === selectedPresetIndex && styles.instrumentRowActive,
                  ]}
                  onPress={() => handleSelectInstrument(item.index)}
                >
                  <Text
                    style={[
                      styles.instrumentName,
                      item.index === selectedPresetIndex && styles.instrumentNameActive,
                    ]}
                  >
                    {item.name}
                  </Text>
                  {item.index === selectedPresetIndex && (
                    <Feather name="check" size={16} color={barPalette.accent} />
                  )}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
};

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/* ─── Styles ─── */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.background },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: palette.background,
  },
  loadingLogoWrap: {
    width: 96,
    height: 72,
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 14,
  },
  loadingLogoWebView: {
    width: 96,
    height: 72,
    backgroundColor: 'transparent',
  },
  scanningText: {
    fontSize: 14,
    color: palette.ink,
    fontWeight: '700',
    letterSpacing: 0.2,
    marginBottom: 4,
  },
  scanningFileText: {
    fontSize: 12,
    color: palette.inkMuted,
    fontWeight: '600',
    marginBottom: 10,
  },
  processingStageText: {
    fontSize: 11,
    color: palette.inkMuted,
    fontWeight: '500',
    marginBottom: 12,
    fontStyle: 'italic',
    letterSpacing: 0.3,
  },
  loadingBarTrack: {
    width: 188,
    height: 3,
    backgroundColor: '#D8D2C6',
    borderRadius: 2,
    overflow: 'hidden',
  },
  loadingBarPulse: {
    height: 3,
    backgroundColor: barPalette.accent,
    borderRadius: 2,
  },
  cancelScanButton: {
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D6D0C4',
    backgroundColor: '#F1EEE4',
  },
  cancelScanButtonText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: '#6E675E',
    textTransform: 'uppercase',
  },
  errorTitle: { fontSize: 18, fontWeight: '700', color: palette.ink, marginBottom: 8 },
  errorText: { fontSize: 13, color: palette.inkMuted, textAlign: 'center', marginBottom: 16, paddingHorizontal: 16 },
  retryButton: {
    backgroundColor: palette.surface,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: palette.border,
  },
  retryButtonText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: palette.background,
  },
  title: {
    fontSize: 21,
    fontWeight: '600',
    color: palette.ink,
    letterSpacing: -0.2,
    fontFamily: Platform.OS === 'ios' ? 'Avenir Next' : 'sans-serif-medium',
  },
  linkText: { fontSize: 14, color: palette.inkMuted, fontWeight: '600' },
  topVoiceBar: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 8,
    backgroundColor: palette.background,
    alignItems: 'stretch',
  },
  topVoiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  topVoicePill: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#E4DACB',
  },
  topVoiceDot: {
    minWidth: 54,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    paddingHorizontal: 10,
  },
  topPitchPipeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 0,
  },
  topVoiceDotActive: {
    backgroundColor: '#F3EBDE',
    borderColor: '#D2BFA3',
  },
  topVoiceDotAll: {
    backgroundColor: '#EEF3EB',
    borderColor: '#B8C7B4',
  },
  topVoiceDotEmpty: {
    backgroundColor: '#FAF8F3',
    borderColor: '#E0D7C8',
    opacity: 0.55,
  },
  topVoiceDotInactive: {
    backgroundColor: '#FFFEFC',
    borderColor: '#E8DDCD',
  },
  topVoiceDotText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.15,
  },
  topVoiceDotTextActive: {
    color: '#3E3C37',
  },
  topVoiceDotTextInactive: {
    color: '#6E675E',
  },
  viewerArea: {
    flex: 1,
    backgroundColor: '#fff',
    marginHorizontal: 12,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E6E2D8',
  },
  tempoDrawer: {
    backgroundColor: barPalette.barRaised,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: barPalette.barBorder,
  },
  tempoDrawerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  tempoDrawerLabel: {
    color: barPalette.barTextMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  tempoDrawerValue: {
    color: barPalette.accent,
    fontSize: 14,
    fontWeight: '800',
  },
  tempoSlider: {
    width: '100%',
    height: 32,
  },
  seekBarWrap: {
    backgroundColor: barPalette.bar,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 2,
    borderTopWidth: 1,
    borderTopColor: barPalette.barBorder,
  },
  seekBarWrapCollapsed: {
    paddingTop: 7,
    paddingBottom: 7,
  },
  seekBarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  seekBarHeaderCollapsed: {
    marginBottom: 0,
  },
  timelineHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  seekBarLabel: {
    color: barPalette.barTextMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  seekBarTimeText: {
    color: barPalette.barText,
    fontSize: 12,
    fontWeight: '700',
  },
  seekSlider: {
    width: '100%',
    height: 30,
  },
  bottomBar: {
    backgroundColor: barPalette.bar,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: barPalette.barBorder,
  },
  barScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
  },
  playPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: barPalette.barRaised,
    borderRadius: 18,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  playPillPaused: {
    borderColor: barPalette.accent,
    backgroundColor: '#332015',
  },
  playPillText: { color: barPalette.barText, fontSize: 12, fontWeight: '700' },
  zoomPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: barPalette.barRaised,
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  pillText: { color: barPalette.barText, fontSize: 12, fontWeight: '600' },
  scoreModeText: {
    color: '#DED8CC',
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.2,
    fontFamily: Platform.OS === 'ios' ? 'Avenir Next' : 'sans-serif-medium',
  },
  scoreModeTextScan: {
    color: '#F2ECE0',
  },
  voiceDot: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    paddingHorizontal: 4,
  },
  voiceDotActive: { backgroundColor: barPalette.accent, borderColor: barPalette.accent },
  voiceDotAll: { backgroundColor: '#2A7B3D', borderColor: '#2A7B3D' },
  voiceDotEmpty: { backgroundColor: barPalette.bar, borderColor: '#555', opacity: 0.4 },
  voiceDotInactive: { backgroundColor: barPalette.bar, borderColor: barPalette.barBorder },
  voiceDotText: { fontSize: 11, fontWeight: '700' },
  voiceDotTextActive: { color: barPalette.barText },
  voiceDotTextInactive: { color: barPalette.barTextMuted },
  viewPill: {
    backgroundColor: barPalette.barRaised,
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  iconPill: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: barPalette.barRaised,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  pressedPill: {
    opacity: 0.6,
    transform: [{ scale: 0.96 }],
  },
  pressedDot: {
    opacity: 0.6,
    transform: [{ scale: 0.9 }],
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: palette.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: palette.ink,
    letterSpacing: -0.3,
  },
  overflowActionsList: {
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  overflowActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
  },
  overflowActionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  overflowColorSwatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
    borderWidth: 1,
  },
  pitchPipePanel: {
    width: '100%',
    maxWidth: 560,
    borderRadius: 24,
    paddingTop: 18,
    paddingBottom: 18,
    paddingHorizontal: 16,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  pitchPipeWheel: {
    alignSelf: 'center',
    width: 280,
    height: 280,
    marginTop: 4,
    marginBottom: 10,
  },
  pitchPipeNoteButton: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pitchPipeNoteLabel: {
    fontSize: 11,
    fontWeight: '700',
  },
  pitchPipeCenter: {
    position: 'absolute',
    left: 88,
    top: 88,
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pitchPipeCenterNote: {
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.2,
  },
  pitchPipeCenterHz: {
    fontSize: 12,
    fontWeight: '700',
  },
  pitchPipeInfoText: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 8,
  },
  pitchPipeSliderWrap: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  pitchPipeSliderLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  pitchPipeSlider: {
    width: '100%',
    height: 30,
  },
  instrumentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  instrumentRowActive: {
    backgroundColor: palette.surfaceStrong,
  },
  instrumentName: {
    fontSize: 14,
    fontWeight: '600',
    color: palette.ink,
    flex: 1,
  },
  instrumentNameActive: {
    color: barPalette.accent,
    fontWeight: '800',
  },
  soundFontSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 14,
  },
  soundFontChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: palette.surfaceStrong,
    borderWidth: 1,
    borderColor: palette.border,
  },
  soundFontChipActive: {
    backgroundColor: '#1C1B19',
    borderColor: '#1C1B19',
  },
  soundFontChipLoading: {
    opacity: 0.7,
  },
  soundFontChipText: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  soundFontChipTextActive: {
    color: '#F3F1EA',
  },
  audioControlsOverlay: {
    flex: 1,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  audioControlsPanel: {
    width: '100%',
    maxWidth: 560,
    backgroundColor: '#F9F3E8',
    borderRadius: 28,
    paddingTop: 20,
    paddingBottom: 20,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: '#D6CDBD',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
    maxHeight: '80%',
  },
  audioControlsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E6DCCD',
  },
  audioControlsTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#2A261F',
    letterSpacing: -0.2,
  },
  audioControlsCloseButton: {
    width: 36,
    height: 36,
    backgroundColor: '#EFE5D6',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DACFBF',
  },
  audioControlsScroll: {
    flex: 0,
  },
  audioControlBlock: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#F6EEDE',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DCCFBB',
    borderLeftWidth: 4,
    borderLeftColor: barPalette.accent,
    marginBottom: 12,
  },
  audioControlRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  audioControlLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6A6154',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  audioControlValue: {
    fontSize: 17,
    fontWeight: '800',
    color: '#2D2922',
  },
  audioSlider: {
    width: '100%',
    height: 32,
  },
});
