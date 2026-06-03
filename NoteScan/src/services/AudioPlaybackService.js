import { Audio } from 'expo-av';
import { File, Paths } from 'expo-file-system/next';
import { SoundFontService } from './SoundFontService';
import { assignPlaybackVoices, collapseVoiceOnsets, resolvePlaybackVoice, getPlaybackVoices, noteMatchesVoiceSelection } from './VoiceGroupService';

// react-native-audio-api requires a dev build (native module).
// Gracefully degrade when running in Expo Go.
let AudioContext = null;
try {
  // Use eval(require) so Metro does not hard-require this optional dependency.
  const optionalRequire = eval('require');
  AudioContext = optionalRequire('react-native-audio-api').AudioContext;
} catch (_) {
  console.warn('[AudioPlaybackService] react-native-audio-api not available – Web Audio disabled, using expo-av fallback');
}

/**
 * Piano audio synthesis and playback engine.
 * Uses react-native-audio-api AudioBufferQueueSourceNode for streaming playback.
 * A single queue node is fed small mixed chunks — tempo changes just clear the
 * queue and re-feed from the current beat position. No per-note nodes.
 * Falls back to expo-av WAV-file path only when Web Audio is unavailable.
 */
export class AudioPlaybackService {
  static sound = null;  // expo-av legacy
  static isPlaying = false;
  static _tempFileUri = null;
  static _soundFontReady = false;
  static _renderTempo = 120;
  static _pitchHz = 440;
  static _pitchCents = 0;
  static _noteWaveformCache = new Map();

  /* ─── Web Audio queue-streaming engine ─── */
  static _audioCtx = null;
  static _audioBufferCache = new Map(); // kept for selectPreset clearing
  static _noteEvents = null;       // [{ midiNote, velocity, beatOffset, durationBeats, voice }]
  static _timingBeatData = null;   // [{ beatOffset, x, y, staffIndex, systemIndex, isRest }]
  static _timepointGraph = null;   // [{ beatOffset, intervalToNextBeat, bar..., sounds[] }]
  static _totalBeats = 0;
  static _totalBeatsCanonical = 0;
  static _playStartTime = 0;       // audioCtx.currentTime when play began
  static _playStartOffset = 0;     // seek offset in seconds
  static _positionTimer = null;
  static _onPositionUpdate = null;
  static _onFinished = null;
  static _currentTempo = 120;

  /* ─── Queue streaming state ─── */
  static _queueNode = null;        // single AudioBufferQueueSourceNode
  static _voiceSelection = null;   // current voice selection for mixing
  static _mixCursor = 0;           // next sample position to mix/enqueue
  static _feedTimer = null;        // setInterval for chunk feeding
  static _CHUNK_SIZE = 4096;       // samples per chunk (~93ms at 44100)
  static _LOOKAHEAD_SEC = 0.5;     // seconds of audio to buffer ahead
  static _FEED_MS = 30;            // ms between feed timer ticks
  static _beatMarkers = null;      // [{ beatOffset, accent }]
  static _beatMarkersOnset = null; // [{ beatOffset, accent }]
  static _beatMarkersOnsetExternal = null; // [{ beatOffset, accent }]
  static _playbackLeadSec = 0;
  static _pitchPreviewSource = null;
  static _pitchPreviewLastAt = 0;
  static _pitchPreviewSound = null;
  static _pitchPreviewUriCache = new Map();
  static _pitchPipeViolaPresetIndex = undefined;

  static setBeatOnlyMode(enabled) {
    // Legacy no-op: beat-only test mode was removed.
    // Keep the method so older UI code can call it safely.
    return !!enabled;
  }

  static setPitchHz(hz) {
    const nextHz = Number.isFinite(hz) && hz > 0 ? hz : 440;
    if (Math.abs(nextHz - this._pitchHz) < 0.001) {
      return;
    }
    this._pitchHz = nextHz;
    this._pitchCents = (Math.log(nextHz / 440.0) * 1200.0) / Math.log(2.0);

    const shouldReseedQueue = this._useWebAudio && this.isPlaying && !!this._queueNode;
    let currentElapsed = 0;
    if (shouldReseedQueue) {
      const ctx = this._getAudioContext();
      if (ctx) {
        currentElapsed = Math.max(0, ctx.currentTime - this._playStartTime + this._playStartOffset);
      }
    }

    this._noteWaveformCache.clear();
    this._audioBufferCache.clear();

    // Rebuild immediately only during active queue playback.
    // When idle, keep updates lightweight and lazily regenerate on next prepare/play.
    if (shouldReseedQueue && this._noteEvents && this._noteEvents.length > 0) {
      this._precacheWaveforms();
    }

    // Refresh queued audio from the current timeline position so pitch changes apply mid-play.
    if (shouldReseedQueue) {
      this._queueNode.clearBuffers();
      this._mixCursor = Math.floor(currentElapsed * 44100);
      const ctx = this._getAudioContext();
      if (ctx) {
        this._playStartTime = ctx.currentTime;
      }
      this._playStartOffset = currentElapsed;
      this._feedChunks();
    }
  }

  static getPreparedNoteEvents() {
    return Array.isArray(this._noteEvents) ? this._noteEvents : [];
  }

  static getPreparedTimingBeatData() {
    return Array.isArray(this._timingBeatData) ? this._timingBeatData : [];
  }

  static getPreparedTimepointGraph() {
    return Array.isArray(this._timepointGraph) ? this._timepointGraph : [];
  }

  static getPreparedTotalBeats() {
    if (Number.isFinite(this._totalBeatsCanonical) && this._totalBeatsCanonical > 0) {
      return this._totalBeatsCanonical;
    }
    if (Number.isFinite(this._totalBeats) && this._totalBeats > 0) {
      return this._totalBeats;
    }
    return 0;
  }

  static setExternalBeatGuideOnsets(beatOffsets, options = {}) {
    const offsets = Array.isArray(beatOffsets)
      ? beatOffsets.filter((b) => Number.isFinite(b))
      : [];
    if (offsets.length === 0) {
      this._beatMarkersOnsetExternal = null;
      return;
    }
    const measureBeats = Array.isArray(options.measureBeats) ? options.measureBeats : [];
    const fallbackTotal = this._totalBeatsCanonical || this._totalBeats || 0;
    const totalBeats = Number.isFinite(options.totalBeats) && options.totalBeats > 0
      ? options.totalBeats
      : fallbackTotal;
    this._beatMarkersOnsetExternal = this._buildOnsetBeatMarkers(offsets, measureBeats, totalBeats);
  }

  /* ─── SoundFont loading ─── */

  /**
   * Load the SoundFont file for high-quality instrument playback.
   * Call this once during app initialization (non-blocking).
   * Defaults to Grand Piano (first preset in the SF2).
   * @param {number} sf2Asset - result of require('./SheetMusicScanner.sf2')
   */
  static async loadSoundFont(sf2Asset, options = {}) {
    try {
      await SoundFontService.loadSoundFont(sf2Asset, options);
      this._soundFontReady = SoundFontService.isLoaded;
      if (this._soundFontReady) {
        console.log('🎹 SoundFont loaded — using high-quality samples');
        try {
          const presets = SoundFontService.getAvailablePresets();
          console.log('🎹 Presets loaded:', presets.map(p=>p.name).slice(0,20));
        } catch(e) { console.warn('Could not list presets after load', e); }
      }
    } catch (e) {
      console.warn('SoundFont load failed, using synthesis fallback:', e);
      this._soundFontReady = false;
    }
  }

  /* ─── Instrument / preset selection ─── */

  /**
   * Return the list of available instrument presets from the loaded SoundFont.
   * Each entry: { index, name, preset, bank }
   */
  static getAvailablePresets() {
    if (!this._soundFontReady) return [];
    return SoundFontService.getAvailablePresets();
  }

  /** Get the currently active preset index. */
  static getActivePresetIndex() {
    return SoundFontService.getActivePresetIndex();
  }

  /**
   * Select an instrument preset by index.
   * Forces re-generation of audio on next prepareAudio call.
   */
  static selectPreset(index) {
    if (!this._soundFontReady) return;
    SoundFontService.selectPreset(index);
    this._noteWaveformCache.clear();
    this._audioBufferCache.clear();
  }

  /* ─── Frequency helpers ─── */

  static midiToFrequency(midiNote, referenceHz = 440) {
    return referenceHz * Math.pow(2, (midiNote - 69) / 12);
  }

  // Use high precision normalization to avoid float-key noise
  // without collapsing distinct nearby musical onsets.
  static _normalizeBeatOffset(beat) {
    if (!Number.isFinite(beat)) return 0;
    return Math.round(beat * 1000000) / 1000000;
  }

  static _buildBeatMarkers(measureBeats, totalBeats) {
    const measures = Array.isArray(measureBeats) ? measureBeats : [];
    const downbeats = measures
      .map((m) => Number(m?.startBeat))
      .filter((b) => Number.isFinite(b))
      .map((b) => this._normalizeBeatOffset(b));

    const maxBeat = Math.max(0, Math.ceil(Number(totalBeats) || 0));
    const markers = [];
    for (let beat = 0; beat <= maxBeat; beat += 1) {
      const beatOffset = this._normalizeBeatOffset(beat);
      const isDownbeat = downbeats.some((db) => Math.abs(db - beatOffset) < 0.001);
      markers.push({ beatOffset, accent: isDownbeat || beat === 0 ? 1 : 0.68 });
    }
    return markers;
  }

  static _buildOnsetBeatMarkers(beatOffsets, measureBeats, totalBeats) {
    const offsets = Array.isArray(beatOffsets)
      ? beatOffsets.filter((b) => Number.isFinite(b)).map((b) => this._normalizeBeatOffset(b))
      : [];

    if (offsets.length === 0) {
      return this._buildBeatMarkers(measureBeats, totalBeats);
    }

    const sorted = [...new Set(offsets)].sort((a, b) => a - b);
    const measures = Array.isArray(measureBeats) ? measureBeats : [];
    return sorted.map((beatOffset) => {
      let accent = 0.78;
      for (const measure of measures) {
        const startBeat = Number(measure?.startBeat);
        const endBeat = Number(measure?.endBeat);
        if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat <= startBeat) continue;
        if (beatOffset >= startBeat - 0.001 && beatOffset < endBeat + 0.001) {
          const beatInMeasure = beatOffset - startBeat;
          if (Math.abs(beatInMeasure) < 0.001) accent = 1;
          break;
        }
      }
      return { beatOffset, accent };
    });
  }

  static _generateBeatClick(sampleRate = 44100, accent = 1) {
    const durationSec = accent > 0.8 ? 0.034 : 0.022;
    const totalSamples = Math.max(1, Math.floor(sampleRate * durationSec));
    const out = new Float32Array(totalSamples);
    const startFreq = accent > 0.8 ? 2200 : 1680;
    const endFreq = accent > 0.8 ? 1560 : 1180;
    const gain = accent > 0.8 ? 0.34 : 0.24;
    for (let i = 0; i < totalSamples; i++) {
      const t = i / Math.max(1, totalSamples - 1);
      const env = Math.pow(1 - t, 3.4);
      const freq = startFreq + (endFreq - startFreq) * t;
      out[i] = Math.sin(2 * Math.PI * freq * (i / sampleRate)) * env * gain * accent;
    }
    return out;
  }

  static _mixBeatGuide(buffer, startSample = 0, sampleRate = 44100, tempo = 120) {
    // Beat click track disabled.
    // Keep method for compatibility with existing call sites.
    return;
  }

  /* ─── Waveform generation ─── */

  /**
   * Generate a note as Float32Array samples (mono 44100 Hz).
   * Uses SoundFont samples when available, otherwise falls back to synthesis.
   */
  static generatePianoNote(midiNote, duration = 1.0, velocity = 100) {
    const sampleRate = 44100;
    const neededSamples = Math.floor(sampleRate * duration);
    const cacheKey = `${midiNote}_${velocity}_${Math.round(this._pitchCents * 1000)}`;
    const cached = this._noteWaveformCache.get(cacheKey);

    if (cached && cached.length >= neededSamples) {
      // Fast path: truncate from cache + anti-click fade
      const out = new Float32Array(neededSamples);
      out.set(cached.subarray(0, neededSamples));
      const fadeSamples = Math.min(Math.floor(sampleRate * 0.003), neededSamples);
      for (let i = 0; i < fadeSamples; i++) {
        out[neededSamples - 1 - i] *= i / fadeSamples;
      }
      return out;
    }

    // Render at 1.5x duration so cache covers ~33% slower tempos too
    const renderDuration = duration * 1.5;
    let fullWaveform;
    if (this._soundFontReady) {
      fullWaveform = SoundFontService.renderNote(midiNote, renderDuration, velocity, this._pitchCents);
    }
    if (!fullWaveform) {
      fullWaveform = this._synthesizeNote(midiNote, renderDuration, velocity);
    }

    // Cache the longer version
    if (!cached || fullWaveform.length > cached.length) {
      this._noteWaveformCache.set(cacheKey, fullWaveform);
    }

    // Return only the needed portion + anti-click fade
    const out = new Float32Array(neededSamples);
    out.set(fullWaveform.subarray(0, Math.min(fullWaveform.length, neededSamples)));
    const fadeSamples = Math.min(Math.floor(sampleRate * 0.003), neededSamples);
    for (let i = 0; i < fadeSamples; i++) {
      out[neededSamples - 1 - i] *= i / fadeSamples;
    }
    return out;
  }

  /**
   * Fallback waveform synthesis (used when SoundFont is unavailable).
   */
  static _synthesizeNote(midiNote, duration = 1.0, velocity = 100) {
    const frequency = this.midiToFrequency(midiNote, this._pitchHz);
    const sampleRate = 44100;
    const sampleCount = Math.floor(sampleRate * duration);
    const audioData = new Float32Array(sampleCount);
    const velocityFactor = velocity / 127;

    const attackTime = 0.008;
    const decayTime = 0.15;
    const sustainLevel = 0.6;
    const releaseTime = Math.min(0.2, duration * 0.15);

    const attackSamples = Math.floor(sampleRate * attackTime);
    const decaySamples = Math.floor(sampleRate * decayTime);
    const releaseSamples = Math.floor(sampleRate * releaseTime);
    const sustainSamples = Math.max(0, sampleCount - attackSamples - decaySamples - releaseSamples);

    // Anti-click fade: 3ms fade-out at the very end of every note
    const fadeOutSamples = Math.min(Math.floor(sampleRate * 0.003), sampleCount);
    const fadeOutStart = sampleCount - fadeOutSamples;

    for (let i = 0; i < sampleCount; i++) {
      let envelope = 0;

      if (i < attackSamples) {
        envelope = i / attackSamples;
      } else if (i < attackSamples + decaySamples) {
        const p = (i - attackSamples) / decaySamples;
        envelope = 1.0 - p * (1.0 - sustainLevel);
      } else if (i < attackSamples + decaySamples + sustainSamples) {
        const p = (i - attackSamples - decaySamples) / Math.max(1, sustainSamples);
        envelope = sustainLevel * (1.0 - p * 0.3);
      } else {
        const p = (i - attackSamples - decaySamples - sustainSamples) / Math.max(1, releaseSamples);
        envelope = sustainLevel * 0.7 * (1.0 - p);
      }

      // Anti-click: tiny fade at the very end to prevent discontinuity
      if (i >= fadeOutStart) {
        envelope *= (sampleCount - 1 - i) / Math.max(1, fadeOutSamples);
      }

      const t = i / sampleRate;
      const fundamental = Math.sin(2 * Math.PI * frequency * t);
      const h2 = 0.35 * Math.sin(2 * Math.PI * frequency * 2 * t);
      const h3 = 0.15 * Math.sin(2 * Math.PI * frequency * 3 * t);
      const h4 = 0.06 * Math.sin(2 * Math.PI * frequency * 4 * t);

      const sample = (fundamental + h2 + h3 + h4) / 1.56;
      audioData[i] = sample * envelope * velocityFactor * 0.75;
    }
    return audioData;
  }

  /* ─── Web Audio API engine ─── */

  /** Returns true if the native Web Audio module is available (dev build only). */
  static isWebAudioAvailable() {
    return AudioContext != null;
  }

  /** Lazily create / return the shared AudioContext. Returns null if Web Audio unavailable. */
  static _getAudioContext() {
    if (!AudioContext) return null;
    if (!this._audioCtx || this._audioCtx.state === 'closed') {
      this._audioCtx = new AudioContext();
    }
    return this._audioCtx;
  }

  static _getPlaybackLeadSec() {
    const ctx = this._getAudioContext();
    if (!ctx) return 0;

    const candidates = [
      Number(ctx.outputLatency),
      Number(ctx.baseLatency),
      Number(this._playbackLeadSec),
    ].filter((value) => Number.isFinite(value) && value >= 0);

    if (candidates.length > 0) {
      return Math.max(0, Math.min(0.08, Math.max(...candidates)));
    }

    return 0.035;
  }

  static _resolveViolaPresetIndex() {
    if (this._pitchPipeViolaPresetIndex !== undefined) {
      return this._pitchPipeViolaPresetIndex;
    }
    if (!this._soundFontReady) {
      this._pitchPipeViolaPresetIndex = null;
      return null;
    }
    const presets = SoundFontService.getAvailablePresets();
    const exact = presets.find((p) => /\bviola\b/i.test(String(p?.name || '')));
    this._pitchPipeViolaPresetIndex = exact ? exact.index : null;
    return this._pitchPipeViolaPresetIndex;
  }

  static _renderPitchPipeSoundFontTone(freq, durationSec, gain = 0.2) {
    if (!this._soundFontReady) return null;
    const violaIdx = this._resolveViolaPresetIndex();
    if (!Number.isFinite(violaIdx)) return null;

    const activePresetIndex = SoundFontService.getActivePresetIndex();
    try {
      if (activePresetIndex !== violaIdx) {
        SoundFontService.selectPreset(violaIdx);
      }

      const midiFloat = 69 + 12 * Math.log2(freq / 440);
      const midiNote = Math.round(midiFloat);
      const tuningCents = (midiFloat - midiNote) * 100;
      const rendered = SoundFontService.renderNote(midiNote, durationSec, 112, tuningCents);
      if (!rendered || rendered.length === 0) return null;

      // Stronger gain for better audibility on phone speakers.
      const out = new Float32Array(rendered.length);
      const scale = Math.max(0.08, Math.min(1, gain)) * 1.28;
      for (let i = 0; i < rendered.length; i++) {
        const boosted = rendered[i] * scale;
        out[i] = Math.max(-0.98, Math.min(0.98, boosted));
      }
      return out;
    } catch (_) {
      return null;
    } finally {
      if (activePresetIndex !== violaIdx) {
        try { SoundFontService.selectPreset(activePresetIndex); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Generate a reed-like pitch-pipe waveform (warmer than a plain sine beep).
   */
  static _generatePitchPipeTone(freq, sampleRate, durationSec, gain = 0.2) {
    const sampleCount = Math.max(1, Math.floor(sampleRate * durationSec));
    const attackSamples = Math.max(1, Math.floor(sampleRate * 0.01));
    const releaseSamples = Math.max(1, Math.floor(sampleRate * 0.03));
    const releaseStart = Math.max(0, sampleCount - releaseSamples);
    const out = new Float32Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      const t = i / sampleRate;

      // Small vibrato adds realism without sounding unstable.
      const vibratoHz = 5.4;
      const vibratoDepth = 0.0045;
      const f = freq * (1 + vibratoDepth * Math.sin(2 * Math.PI * vibratoHz * t));

      // Reed-like harmonic blend.
      const fundamental = Math.sin(2 * Math.PI * f * t);
      const h2 = 0.42 * Math.sin(2 * Math.PI * f * 2 * t + 0.16);
      const h3 = 0.24 * Math.sin(2 * Math.PI * f * 3 * t + 0.31);
      const h4 = 0.11 * Math.sin(2 * Math.PI * f * 4 * t + 0.48);

      // Very low breath noise so it does not feel synthetic.
      const noise = (Math.random() * 2 - 1) * 0.015;

      let env = 1;
      if (i < attackSamples) {
        env = i / attackSamples;
      } else if (i >= releaseStart) {
        env = (sampleCount - i) / releaseSamples;
      }

      out[i] = (fundamental + h2 + h3 + h4 + noise) * env * gain * 1.05;
    }

    return out;
  }

  /**
   * Play a short low-latency reference tone for pitch-pipe style UX.
   * Uses Web Audio directly and can retrigger quickly while sliding.
   */
  static playPitchPreviewHz(hz, options = {}) {
    const freq = Number.isFinite(hz) && hz > 0 ? hz : 440;
    const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : 520;
    const retriggerMs = Number.isFinite(options.retriggerMs) ? options.retriggerMs : 28;
    const gain = Number.isFinite(options.gain) ? options.gain : 0.6;

    const ctx = this._getAudioContext();
    if (!ctx) {
      this._playPitchPreviewExpoFallback(freq, options);
      return true;
    }
    if (ctx.state === 'suspended') {
      try { ctx.resume(); } catch (_) { return false; }
    }

    const nowMs = Date.now();
    if (nowMs - this._pitchPreviewLastAt < retriggerMs) {
      return false;
    }
    this._pitchPreviewLastAt = nowMs;

    const sampleRate = 44100;
    const durationSec = Math.max(0.06, durationMs / 1000);
    const tone = this._renderPitchPipeSoundFontTone(freq, durationSec, gain)
      || this._generatePitchPipeTone(freq, sampleRate, durationSec, gain);
    const sampleCount = tone.length;

    const buffer = ctx.createBuffer(1, sampleCount, sampleRate);
    const ch = buffer.getChannelData(0);
    ch.set(tone);

    try {
      if (this._pitchPreviewSource) {
        try { this._pitchPreviewSource.stop(); } catch (_) {}
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
      this._pitchPreviewSource = src;
      src.onended = () => {
        if (this._pitchPreviewSource === src) {
          this._pitchPreviewSource = null;
        }
      };
      return true;
    } catch (_) {
      this._playPitchPreviewExpoFallback(freq, options);
      return false;
    }
  }

  static async _playPitchPreviewExpoFallback(hz, options = {}) {
    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
      });

      const freq = Number.isFinite(hz) && hz > 0 ? hz : 440;
      const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : 520;
      const gain = Number.isFinite(options.gain) ? options.gain : 0.6;
      const key = `${Math.round(freq)}_${Math.round(durationMs)}_${Math.round(gain * 100)}`;

      let uri = this._pitchPreviewUriCache.get(key);
      if (!uri) {
        const sampleRate = 44100;
        const durationSec = Math.max(0.06, durationMs / 1000);
        const audioData = this._renderPitchPipeSoundFontTone(freq, durationSec, gain)
          || this._generatePitchPipeTone(freq, sampleRate, durationSec, 0.7);

        uri = await this.writeWavToFile(audioData);
        this._pitchPreviewUriCache.set(key, uri);
      }

      if (this._pitchPreviewSound) {
        try {
          await this._pitchPreviewSound.stopAsync();
          await this._pitchPreviewSound.unloadAsync();
        } catch (_) { /* ignore */ }
        this._pitchPreviewSound = null;
      }

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        {
          shouldPlay: true,
          volume: 1,
          progressUpdateIntervalMillis: 16,
        }
      );
      this._pitchPreviewSound = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status?.isLoaded) return;
        if (status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          if (this._pitchPreviewSound === sound) {
            this._pitchPreviewSound = null;
          }
        }
      });
    } catch (e) {
      console.warn('[AudioPlaybackService] Pitch preview fallback failed:', e?.message || e);
    }
  }

  /**
   * Pre-generate Float32Array waveforms for all unique (midiNote, velocity) combos.
   * Renders each at the longest needed duration (slowest tempo = 40 BPM)
   * so the chunk mixer can read from them at any tempo.
   */
  static _precacheWaveforms() {
    if (!this._noteEvents || this._noteEvents.length === 0) return;
    const spbSlow = 60 / 40; // seconds-per-beat at 40 BPM (slider minimum)

    // Find max durationBeats for each unique (midiNote, velocity)
    const noteMaxBeats = new Map();
    for (const evt of this._noteEvents) {
      const key = `${evt.midiNote}_${evt.velocity}`;
      const cur = noteMaxBeats.get(key) || 0;
      if (evt.durationBeats > cur) noteMaxBeats.set(key, evt.durationBeats);
    }

    // Generate waveform for each unique note at max possible duration
    // generatePianoNote populates _noteWaveformCache automatically
    for (const [key, maxBeats] of noteMaxBeats) {
      const [midi, vel] = key.split('_').map(Number);
      const maxSec = maxBeats * spbSlow;
      this.generatePianoNote(midi, maxSec, vel);
    }

    console.log(`🎹 Pre-cached ${noteMaxBeats.size} waveforms for ${this._noteEvents.length} events`);
  }

  /**
   * Prepare note events from scoreData (parse once, reuse across tempos).
   * Returns { noteEvents, timingBeatData, totalBeats }.
   */
  static prepareNoteEvents(notes, options = {}) {
    const measureBeats = Array.isArray(options.measureBeats) ? options.measureBeats : [];
    const transposeSemitones = Number.isFinite(options.transposeSemitones)
      ? Math.round(options.transposeSemitones)
      : 0;
    const applyTranspose = (midiNote) => {
      if (!Number.isFinite(midiNote)) return midiNote;
      const transposed = Math.round(midiNote + transposeSemitones);
      return Math.max(0, Math.min(127, transposed));
    };
    const getBeats = (n) => n.tiedBeats || n.durationBeats || ({
      whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25,
      '32nd': 0.125, dotted_whole: 6, dotted_half: 3, dotted_quarter: 1.5,
      dotted_eighth: 0.75, dotted_sixteenth: 0.375, dotted_32nd: 0.1875,
      dotted_dotted_whole: 7, dotted_dotted_half: 3.5, dotted_dotted_quarter: 1.75,
      dotted_dotted_eighth: 0.875, dotted_dotted_sixteenth: 0.4375, dotted_dotted_32nd: 0.21875,
    })[n.duration] || 1;

    const hasBeatOffset = notes.some(n => typeof n.beatOffset === 'number' && Number.isFinite(n.beatOffset));
    if (!hasBeatOffset) {
      this._timepointGraph = null;
      this._beatMarkers = null;
      this._beatMarkersOnset = null;
      this._beatMarkersOnsetExternal = null;
      return null;
    }

    // Keep only real note events for audio scheduling.
    // Rests are tracked separately for cursor timing but must not become synth events.
    const realNotes = notes.filter(
      n => n.type === 'note' && Number.isFinite(n.midiNote) && Number.isFinite(n.beatOffset)
    );
    let totalBeats = 0;
    for (const n of realNotes) {
      const dur = getBeats(n);
      const endBeat = n.beatOffset + dur;
      totalBeats = Math.max(totalBeats, endBeat);
    }
    if (totalBeats === 0) totalBeats = 1; // avoid division by zero

    const normalizedMeasures = measureBeats
      .filter((m) => Number.isFinite(m?.startBeat) && Number.isFinite(m?.endBeat))
      .sort((a, b) => a.startBeat - b.startBeat);

    const mapBeatToMeasure = (beat) => {
      if (!Number.isFinite(beat) || normalizedMeasures.length === 0) {
        return {
          measureIndex: -1,
          measureNum: -1,
          measureStartBeat: null,
          measureEndBeat: null,
        };
      }
      for (let i = 0; i < normalizedMeasures.length; i++) {
        const m = normalizedMeasures[i];
        if (beat >= m.startBeat && beat < m.endBeat) {
          return {
            measureIndex: i,
            measureNum: Number.isFinite(m.measureNum) ? m.measureNum : i + 1,
            measureStartBeat: m.startBeat,
            measureEndBeat: m.endBeat,
          };
        }
      }
      return {
        measureIndex: -1,
        measureNum: -1,
        measureStartBeat: null,
        measureEndBeat: null,
      };
    };
    
    const noteFormatted = realNotes.map(n => {
      const canonicalBeatOffset = this._normalizeBeatOffset(n.beatOffset);
      const measureInfo = mapBeatToMeasure(canonicalBeatOffset);
      const x = n.x || 0; // Use OCR x if available, else 0 (will be synthesized below)
      const y = n.y || 0;
      return {
        xmlId: n.xmlId || n.noteId || n.id || null,
        midiNote: applyTranspose(n.midiNote),
        velocity: 100,
        beatOffsetCanonical: canonicalBeatOffset,
        beatOffsetCompressed: canonicalBeatOffset,
        beatOffset: canonicalBeatOffset, // Backward-compatible alias to compressed timeline
        durationBeats: getBeats(n),
        voice: n.voice || 'Soprano',
        x,
        y,
        measureIndex: measureInfo.measureIndex,
        measureNum: measureInfo.measureNum,
        staffIndex: n.staffIndex,
        systemIndex: n.systemIndex ?? 0,
        measureStartBeat: measureInfo.measureStartBeat,
        measureEndBeat: measureInfo.measureEndBeat,
      };
    });

    // Synthesize x positions from beatOffset if not set
    // This maps musical time (beats) to horizontal screen position
    // totalBeats maps to max x (assume ~1200px for landscape sheet music)
    const SYNTHESIZED_WIDTH = 1200;
    const assignedEvents = assignPlaybackVoices(noteFormatted.map(n => {
      const synthX = (n.beatOffset / totalBeats) * SYNTHESIZED_WIDTH;
      return {
        ...n,
        x: n.x > 0 ? n.x : synthX, // Use OCR x if available, else synthesized
      };
    }));
    const noteEvents = collapseVoiceOnsets(assignedEvents);

    const rests = notes
      .filter(n => n.type === 'rest' && Number.isFinite(n.beatOffset))
      .map((r) => {
        const canonicalBeatOffset = this._normalizeBeatOffset(r.beatOffset);
        const measureInfo = mapBeatToMeasure(canonicalBeatOffset);
        return {
          ...r,
          beatOffsetCanonical: canonicalBeatOffset,
          beatOffsetCompressed: canonicalBeatOffset,
          beatOffset: canonicalBeatOffset, // Backward-compatible alias to compressed timeline
          measureIndex: measureInfo.measureIndex,
          measureNum: measureInfo.measureNum,
          measureStartBeat: measureInfo.measureStartBeat,
          measureEndBeat: measureInfo.measureEndBeat,
        };
      });

    // Build beat-based timing map (beat positions → coordinates)
    let beatMap = new Map();
    for (const e of noteEvents) {
      if (!beatMap.has(e.beatOffset)) beatMap.set(e.beatOffset, []);
      beatMap.get(e.beatOffset).push(e);
    }
    let beatPositions = [...beatMap.keys()].sort((a, b) => a - b);

    // Canonical-only rule path: do not compress or heuristically remap timeline gaps.

    const timingBeatData = [];
    for (const bo of beatPositions) {
      const group = beatMap.get(bo);
      const measureInfo = mapBeatToMeasure(bo);
      const avgX = group.reduce((s, n) => s + n.x, 0) / group.length;
      const avgY = group.reduce((s, n) => s + n.y, 0) / group.length;
      // Per-voice positions for voice-aware subtle dots
      const voicePositions = group.map(n => ({ voice: resolvePlaybackVoice(n), y: n.y, x: n.x }));
      timingBeatData.push({
        beatOffset: bo,
        beatOffsetCanonical: Math.min(...group.map((n) => n.beatOffsetCanonical ?? n.beatOffset)),
        beatOffsetCompressed: bo,
        measureIndex: measureInfo.measureIndex,
        measureNum: measureInfo.measureNum,
        measureStartBeat: measureInfo.measureStartBeat,
        measureEndBeat: measureInfo.measureEndBeat,
        x: avgX,
        y: avgY,
        voicePositions,
        staffIndex: group[0].staffIndex,
        systemIndex: group[0].systemIndex,
        isRest: false,
      });
    }

    // Add rests
    for (const r of rests) {
      const rbo = this._normalizeBeatOffset(r.beatOffset);
      if (!beatMap.has(rbo)) {
        const measureInfo = mapBeatToMeasure(rbo);
        const synthX = (rbo / totalBeats) * SYNTHESIZED_WIDTH;
        timingBeatData.push({
          beatOffset: rbo,
          beatOffsetCanonical: r.beatOffsetCanonical ?? rbo,
          beatOffsetCompressed: rbo,
          measureIndex: measureInfo.measureIndex,
          measureNum: measureInfo.measureNum,
          measureStartBeat: measureInfo.measureStartBeat,
          measureEndBeat: measureInfo.measureEndBeat,
          x: r.x > 0 ? r.x : synthX,
          y: r.y || 0,
          staffIndex: r.staffIndex,
          systemIndex: r.systemIndex ?? 0,
          isRest: true,
        });
      }
    }
    timingBeatData.sort((a, b) => a.beatOffset - b.beatOffset);

    // Canonical-only rule path: active beat offset always follows canonical timing.
    for (const e of noteEvents) {
      e.beatOffset = e.beatOffsetCanonical ?? e.beatOffsetCompressed ?? e.beatOffset;
    }

    // Build a deterministic bar/timepoint graph from prepared timing + events.
    const timepointGraph = [];
    const orderedTimepoints = timingBeatData
      .map((t, idx) => ({
        ...t,
        _beatNormalized: this._normalizeBeatOffset(t.beatOffsetCanonical ?? t.beatOffset),
        _timingIdx: idx,
      }))
      .filter((t) => Number.isFinite(t._beatNormalized))
      .sort((a, b) => a._beatNormalized - b._beatNormalized);

    for (let i = 0; i < orderedTimepoints.length; i++) {
      const timing = orderedTimepoints[i];
      const beatOffset = timing._beatNormalized;
      const nextBeatOffset =
        i + 1 < orderedTimepoints.length ? orderedTimepoints[i + 1]._beatNormalized : null;
      const intervalToNextBeat = Number.isFinite(nextBeatOffset)
        ? Math.max(0, nextBeatOffset - beatOffset)
        : null;

      // Look up sound events from the original timingBeatData using stored reference
      const group = beatMap.get(timing.beatOffset) || [];
      const sounds = group
        .slice()
        .sort((a, b) => {
          const sa = Number.isFinite(a?.staffIndex) ? a.staffIndex : 0;
          const sb = Number.isFinite(b?.staffIndex) ? b.staffIndex : 0;
          if (sa !== sb) return sa - sb;
          const ma = Number.isFinite(a?.midiNote) ? a.midiNote : -Infinity;
          const mb = Number.isFinite(b?.midiNote) ? b.midiNote : -Infinity;
          return mb - ma;
        })
        .map((event) => {
          const audioDurationBeats = Number.isFinite(event.durationBeats) ? event.durationBeats : 1;
          const measureEndBeat = Number.isFinite(timing.measureEndBeat)
            ? timing.measureEndBeat
            : null;
          const hardStopBeat = Math.min(
            Number.isFinite(nextBeatOffset) ? nextBeatOffset : Number.POSITIVE_INFINITY,
            Number.isFinite(measureEndBeat) ? measureEndBeat : Number.POSITIVE_INFINITY
          );
          const maxDisplayDuration = Number.isFinite(hardStopBeat)
            ? Math.max(0, hardStopBeat - beatOffset)
            : audioDurationBeats;
          const displayDurationBeats = Math.max(
            0,
            Math.min(audioDurationBeats, maxDisplayDuration)
          );
          return {
            elementId: event.xmlId || event.noteId || event.id || null,
            voice: event.voice || '',
            midiNote: Number.isFinite(event.midiNote) ? event.midiNote : null,
            staffIndex: Number.isFinite(event.staffIndex) ? event.staffIndex : null,
            systemIndex: Number.isFinite(event.systemIndex) ? event.systemIndex : null,
            measureIndex: Number.isFinite(event.measureIndex) ? event.measureIndex : null,
            measureNum: Number.isFinite(event.measureNum) ? event.measureNum : null,
            audioDurationBeats,
            displayDurationBeats,
          };
        });

      timepointGraph.push({
        beatOffset,
        intervalToNextBeat,
        barIndex: Number.isFinite(timing.measureIndex) ? timing.measureIndex : -1,
        measureNum: Number.isFinite(timing.measureNum) ? timing.measureNum : -1,
        barStartBeat: Number.isFinite(timing.measureStartBeat)
          ? timing.measureStartBeat
          : beatOffset,
        barEndBeat: Number.isFinite(timing.measureEndBeat)
          ? timing.measureEndBeat
          : beatOffset,
        isRest: !!timing.isRest || sounds.length === 0,
        sounds,
      });
    }

    this._noteEvents = noteEvents;
    this._timingBeatData = timingBeatData;
    this._timepointGraph = timepointGraph;
    this._totalBeats = noteEvents.reduce(
      (mx, e) => Math.max(mx, (e.beatOffsetCanonical ?? e.beatOffset) + (e.durationBeats || 0)),
      0
    );
    this._totalBeatsCanonical = noteEvents.reduce(
      (mx, e) => Math.max(mx, (e.beatOffsetCanonical ?? e.beatOffset) + (e.durationBeats || 0)),
      0
    );
    this._beatMarkers = this._buildBeatMarkers(
      measureBeats,
      this._totalBeatsCanonical || this._totalBeats
    );
    this._beatMarkersOnset = this._buildOnsetBeatMarkers(
      beatPositions,
      measureBeats,
      this._totalBeatsCanonical || this._totalBeats
    );

    // Pre-generate all waveforms so play/tempo-change is instant
    this._precacheWaveforms();

    console.log(`🎵 Prepared ${noteEvents.length} note events (+${rests.length} rests), ${this._totalBeats.toFixed(1)} total beats, mode=canonical`);
    return { noteEvents, timingBeatData, timepointGraph, totalBeats: this._totalBeats, timelineMode: 'canonical' };
  }

  /**
   * Build the timing map for a given tempo (pure arithmetic, instant).
   */
  static buildTimingMap(tempo) {
    if (!this._timingBeatData) return [];
    const spb = 60 / tempo;
    return this._timingBeatData.map(t => ({
      time: (t.beatOffsetCanonical ?? t.beatOffset) * spb,
      beatOffset: t.beatOffsetCanonical ?? t.beatOffset,
      beatOffsetCanonical: t.beatOffsetCanonical ?? t.beatOffset,
      beatOffsetCompressed: t.beatOffsetCompressed ?? t.beatOffset,
      x: t.x,
      y: t.y,
      voicePositions: t.voicePositions || [],
      staffIndex: t.staffIndex,
      systemIndex: t.systemIndex,
      isRest: t.isRest,
      timelineMode: 'canonical',
    }));
  }

  /**
   * Build a pitch timeline for waveform display.
   * Returns [{ time, endTime, midiNote, voice }] sorted by time.
   */
  static buildPitchTimeline(tempo) {
    if (!this._noteEvents || !tempo) return [];
    const spb = 60 / tempo;
    return this._noteEvents.map(e => ({
      time: (e.beatOffsetCanonical ?? e.beatOffset) * spb,
      endTime: ((e.beatOffsetCanonical ?? e.beatOffset) + e.durationBeats) * spb,
      midiNote: e.midiNote,
      voice: resolvePlaybackVoice(e),
    })).sort((a, b) => a.time - b.time);
  }

  /**
   * Mix one chunk of audio: find active notes overlapping the sample range,
   * read from _noteWaveformCache Float32Arrays, and sum into output.
   */
  static _mixChunk(startSample, chunkSize) {
    const sampleRate = 44100;
    const spb = 60 / this._currentTempo;
    const chunk = new Float32Array(chunkSize);

    const t0 = startSample / sampleRate;
    const t1 = (startSample + chunkSize) / sampleRate;

    for (const evt of this._noteEvents) {
      if (this._voiceSelection && !noteMatchesVoiceSelection(evt, this._voiceSelection)) continue;

      const noteStart = evt.beatOffset * spb;
      const noteDur = evt.durationBeats * spb;
      const noteEnd = noteStart + noteDur;

      if (noteEnd <= t0 || noteStart >= t1) continue;

      const cacheKey = `${evt.midiNote}_${evt.velocity}`;
      const waveform = this._noteWaveformCache.get(cacheKey);
      if (!waveform) continue;

      const noteStartSample = Math.round(noteStart * sampleRate);
      const chunkStart = Math.max(0, noteStartSample - startSample);
      const waveOffset = Math.max(0, startSample - noteStartSample);
      const waveEnd = Math.min(waveform.length, Math.round(noteDur * sampleRate));

      for (let i = chunkStart; i < chunkSize; i++) {
        const wi = waveOffset + (i - chunkStart);
        if (wi >= waveEnd || wi >= waveform.length) break;
        chunk[i] += waveform[wi];
      }
    }

    // Soft-clip to prevent harsh distortion
    let peak = 0;
    for (let i = 0; i < chunkSize; i++) {
      const a = Math.abs(chunk[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1) {
      const inv = 1 / peak;
      for (let i = 0; i < chunkSize; i++) chunk[i] *= inv;
    }

    // Add beat guide after note normalization so dense passages don't bury the pulse.
    this._mixBeatGuide(chunk, startSample, sampleRate, this._currentTempo);

    // Final light limiter after adding beat guide.
    peak = 0;
    for (let i = 0; i < chunkSize; i++) {
      const a = Math.abs(chunk[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1) {
      const inv = 1 / peak;
      for (let i = 0; i < chunkSize; i++) chunk[i] *= inv;
    }

    return chunk;
  }

  /**
   * Enqueue mixed chunks to keep the AudioBufferQueueSourceNode fed.
   * Maintains _LOOKAHEAD_SEC of audio queued ahead of current playback position.
   */
  static _feedChunks() {
    if (!this._queueNode || !this._noteEvents) return;

    const sampleRate = 44100;
    const spb = 60 / this._currentTempo;
    const totalSamples = Math.ceil(this._totalBeats * spb * sampleRate);
    const ctx = this._getAudioContext();

    const elapsed = ctx.currentTime - this._playStartTime + this._playStartOffset;
    const currentSample = Math.max(0, Math.floor(elapsed * sampleRate));
    const lookaheadSamples = Math.floor(this._LOOKAHEAD_SEC * sampleRate);
    const targetSample = Math.min(currentSample + lookaheadSamples, totalSamples);

    while (this._mixCursor < targetSample) {
      const remaining = totalSamples - this._mixCursor;
      const size = Math.min(this._CHUNK_SIZE, remaining);
      const chunk = this._mixChunk(this._mixCursor, size);

      const buf = ctx.createBuffer(1, size, sampleRate);
      buf.getChannelData(0).set(chunk);
      this._queueNode.enqueueBuffer(buf);
      this._mixCursor += size;
    }

    if (this._mixCursor >= totalSamples) {
      this._stopFeedTimer();
    }
  }

  /** Start the feed timer that keeps chunks flowing. */
  static _startFeedTimer() {
    this._stopFeedTimer();
    this._feedTimer = setInterval(() => this._feedChunks(), this._FEED_MS);
  }

  /** Stop the feed timer. */
  static _stopFeedTimer() {
    if (this._feedTimer) {
      clearInterval(this._feedTimer);
      this._feedTimer = null;
    }
  }

  /** Stop queue playback completely (node + timers). */
  static _stopQueue() {
    this._stopFeedTimer();
    this._stopPositionTracking();
    if (this._queueNode) {
      try { this._queueNode.stop(); } catch (_) {}
      this._queueNode = null;
    }
  }

  /** Start a 60fps position tracking timer. */
  static _startPositionTracking(remainingDuration) {
    this._stopPositionTracking();
    const ctx = this._getAudioContext();

    this._positionTimer = setInterval(() => {
      if (!this.isPlaying) {
        this._stopPositionTracking();
        return;
      }
      // Read live playback anchors each tick so seek/tempo changes stay in sync.
      const elapsed = ctx.currentTime - this._playStartTime + this._playStartOffset;
      if (this._onPositionUpdate) this._onPositionUpdate(elapsed);

      if (elapsed >= this._totalBeats * (60 / this._currentTempo)) {
        this.isPlaying = false;
        this._stopPositionTracking();
        this._stopQueue();
        if (this._onFinished) this._onFinished();
      }
    }, 16);
  }

  /** Stop position tracking timer. */
  static _stopPositionTracking() {
    if (this._positionTimer) {
      clearInterval(this._positionTimer);
      this._positionTimer = null;
    }
  }

  /**
   * Instantly change tempo during playback (or before play).
   * Reschedules all notes with new timing — no re-synthesis.
   */
  static changeTempo(newTempo, voiceSelection) {
    if (!this._noteEvents) return null;

    const timingMap = this.buildTimingMap(newTempo);
    const totalDuration = this._totalBeats * (60 / newTempo);

    if (this.isPlaying && this._queueNode) {
      const ctx = this._getAudioContext();
      const elapsed = ctx.currentTime - this._playStartTime + this._playStartOffset;
      const currentBeat = elapsed * this._currentTempo / 60;

      // Clear queued audio and re-feed from current beat with new tempo
      this._queueNode.clearBuffers();

      const newElapsed = currentBeat * 60 / newTempo;
      this._currentTempo = newTempo;
      this._mixCursor = Math.floor(newElapsed * 44100);
      this._playStartTime = ctx.currentTime;
      this._playStartOffset = newElapsed;
      this._voiceSelection = voiceSelection;

      this._feedChunks();
    }

    this._currentTempo = newTempo;
    this._renderTempo = newTempo;

    return { timingMap, totalDuration };
  }

  /* ─── WAV encoding ─── */

  /**
   * Encode Float32Array samples into a WAV file and write to temp storage.
   * Returns the file URI (no huge base64 string in memory).
   */
  static async writeWavToFile(audioData) {
    const sampleRate = 44100;
    const bytesPerSample = 2;

    // Guard: ensure we have actual audio data
    if (!audioData || audioData.length === 0) {
      // Create minimum valid WAV (silence) — 0.1 s
      audioData = new Float32Array(Math.floor(sampleRate * 0.1));
    }

    const subChunk2Size = audioData.length * bytesPerSample;
    const totalBytes = 44 + subChunk2Size;
    const wavBuffer = new ArrayBuffer(totalBytes);
    const view = new DataView(wavBuffer);

    const ws = (o, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    };
    ws(0, 'RIFF');
    view.setUint32(4, 36 + subChunk2Size, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);      // PCM
    view.setUint16(22, 1, true);      // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);  // block align
    view.setUint16(34, 16, true);      // bits per sample
    ws(36, 'data');
    view.setUint32(40, subChunk2Size, true);

    let offset = 44;
    for (let i = 0; i < audioData.length; i++) {
      const s = Math.max(-1, Math.min(1, audioData[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    // Write raw WAV bytes directly to a temp file
    const bytes = new Uint8Array(wavBuffer);
    const fileName = 'notescan_playback_' + Date.now() + '.wav';
    const file = new File(Paths.cache, fileName);
    try {
      file.write(bytes);
    } catch (err) {
      console.error('❌ WAV write error:', err);
      throw err;
    }

    console.log(`🎵 WAV file written: ${(totalBytes / 1024).toFixed(0)} KB, ${(audioData.length / sampleRate).toFixed(1)}s`);
    return file.uri;
  }

  /* ─── Combined audio generation ─── */

  /**
   * Build a single WAV containing all notes with correct timestamps.
   *
   * Uses `beatOffset` (set by MusicXMLParser) to place each note at
   * its exact rhythmic position. Notes sharing the same beatOffset
   * play simultaneously — this correctly handles chords, multi-staff
   * writing, and backup elements in MusicXML.
   *
   * Falls back to the old x-position-based grouping only when no
   * beatOffset data is present (legacy OMR path).
   *
   * @param {Array} notes - notes/rests with midiNote, duration, beatOffset, x, y, staffIndex, voice
   * @param {number} tempo - BPM
   * @param {Array} [systemsMetadata] - OMR-detected systems
   * @returns {Promise<{ fileUri: string, timingMap: Array, totalDuration: number }>}
   */
  static async createCombinedAudio(notes, tempo = 120, systemsMetadata = null) {
    const sampleRate = 44100;
    const secondsPerBeat = 60 / tempo;
    const durationMap = {
      whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25,
      '32nd': 0.125,
      dotted_whole: 6, dotted_half: 3, dotted_quarter: 1.5,
      dotted_eighth: 0.75, dotted_sixteenth: 0.375, dotted_32nd: 0.1875,
      dotted_dotted_whole: 7, dotted_dotted_half: 3.5, dotted_dotted_quarter: 1.75,
      dotted_dotted_eighth: 0.875, dotted_dotted_sixteenth: 0.4375, dotted_dotted_32nd: 0.21875,
    };

    if (!notes || notes.length === 0) {
      return { fileUri: '', timingMap: [], totalDuration: 0 };
    }

    // Check if beatOffset data is available (set by the new MusicXMLParser)
    const hasBeatOffset = notes.some(n => typeof n.beatOffset === 'number' && Number.isFinite(n.beatOffset));

    if (!hasBeatOffset) {
      throw new Error('Clean pipeline requires beatOffset timing data; legacy x-position fallback is disabled.');
    }

    // ── Beat-offset-based rendering (new, correct path) ──

    const getBeats = (n) => n.tiedBeats || n.durationBeats || durationMap[n.duration] || 1;

    // Filter to actual notes (not rests) and sort by beatOffset
    const realNotes = notes.filter(n => n.type !== 'rest' && n.midiNote != null);

    // ── Diagnostic: log first 20 notes ──
    const preview = realNotes.slice(0, 20).map(n =>
      `${n.pitch || '?'}@${n.beatOffset?.toFixed(1)}(${n.duration || '?'})`
    ).join(' ');
    console.log(`🎵 First notes: ${preview}`);

    // Group notes by beatOffset (notes with same beatOffset play together)
    const beatMap = new Map(); // beatOffset → [note, ...]
    for (const n of realNotes) {
      const bo = this._normalizeBeatOffset(n.beatOffset);
      if (!beatMap.has(bo)) beatMap.set(bo, []);
      beatMap.get(bo).push(n);
    }

    // Sort beat positions chronologically
    const beatPositions = [...beatMap.keys()].sort((a, b) => a - b);

    // Build timing map and chord metadata
    const timingMap = [];
    const chordMeta = []; // { offsetSamples, notes: [{midiNote, dur}] }

    for (const bo of beatPositions) {
      const group = beatMap.get(bo);
      const time = bo * secondsPerBeat;

      // Average x/y for cursor
      const avgX = group.reduce((s, n) => s + (n.x || 0), 0) / group.length;
      const avgY = group.reduce((s, n) => s + (n.y || 0), 0) / group.length;
      const si = group[0].staffIndex;
      const voicePositions = group.map((n) => ({
        voice: resolvePlaybackVoice(n),
        x: Number.isFinite(n.x) ? n.x : avgX,
        y: Number.isFinite(n.y) ? n.y : avgY,
      }));

      timingMap.push({
        time,
        x: avgX,
        y: avgY,
        voicePositions,
        staffIndex: si,
        systemIndex: group[0].systemIndex ?? 0,
        isRest: false,
      });

      const noteEntries = group.map(n => ({
        midiNote: n.midiNote ?? 60,
        dur: getBeats(n) * secondsPerBeat,
      }));

      chordMeta.push({
        offsetSamples: Math.floor(time * sampleRate),
        notes: noteEntries,
      });
    }

    // Also include rests in the timing map for cursor tracking
    const rests = notes.filter(n => n.type === 'rest' && typeof n.beatOffset === 'number');
    for (const r of rests) {
      const time = r.beatOffset * secondsPerBeat;
      // Only add if no note event exists at this time
      if (!beatMap.has(this._normalizeBeatOffset(r.beatOffset))) {
        timingMap.push({
          time, x: r.x || 0, y: r.y || 0, staffIndex: r.staffIndex, systemIndex: r.systemIndex ?? 0, isRest: true,
        });
      }
    }

    // Sort timing map by time
    timingMap.sort((a, b) => a.time - b.time);

    // Compute total duration
    let globalTime = 0;
    if (beatPositions.length > 0) {
      const lastBeat = beatPositions[beatPositions.length - 1];
      const lastGroup = beatMap.get(lastBeat);
      const maxBeats = Math.max(...lastGroup.map(getBeats));
      globalTime = (lastBeat + maxBeats) * secondsPerBeat;
    }

    // Build master buffer
    const tailSec = 0.3;
    const totalSamples = Math.floor((globalTime + tailSec) * sampleRate);
    const master = new Float32Array(totalSamples);

    for (const meta of chordMeta) {
      for (const n of meta.notes) {
        const noteAudio = this.generatePianoNote(n.midiNote, n.dur);
        const start = meta.offsetSamples;
        const len = Math.min(noteAudio.length, totalSamples - start);
        for (let i = 0; i < len; i++) master[start + i] += noteAudio[i];
      }
    }

    // Sanitize and normalize
    for (let i = 0; i < master.length; i++) {
      if (!Number.isFinite(master[i])) master[i] = 0;
    }
    let masterPeak = 0;
    for (let i = 0; i < master.length; i++) masterPeak = Math.max(masterPeak, Math.abs(master[i]));
    if (masterPeak > 1) for (let i = 0; i < master.length; i++) master[i] /= masterPeak;

    const fileUri = await this.writeWavToFile(master);

    const source = this._soundFontReady ? 'SoundFont' : 'synthesis';
    console.log(
      `🎹 Combined audio (${source}, beat-offset): ${globalTime.toFixed(1)}s, ` +
      `${timingMap.length} timing points, ${chordMeta.length} beat events`
    );

    return { fileUri, timingMap, totalDuration: globalTime };
  }

  /* ─── Pre-rendered voice tracks ─── */

  // Cached voice buffers and metadata
  static _voiceBuffers = null; // { Soprano: Float32Array, Alto: ..., Tenor: ..., Bass: ... }
  static _voiceTimingMap = null;
  static _voiceTotalDuration = 0;
  static _voiceRenderKey = null; // "presetIdx" to detect instrument changes

  // Cached note event data — avoids re-parsing notes on tempo-only changes
  static _cachedNotes = null;
  static _cachedBeatData = null; // { beatMap, beatPositions, rests, getBeats }

  /**
   * Pre-render separate audio buffers for each SATB voice.
   * Called once when scoreData, tempo, or instrument changes.
   * After this, voice selection changes are instant (just mix buffers).
   *
   * @returns {{ timingMap, totalDuration }} - shared timing data
   */
  static async preRenderVoiceTracks(notes, tempo = 120, options = {}) {
    const sampleRate = 44100;
    const secondsPerBeat = 60 / tempo;
    const renderKey = `${this.getActivePresetIndex()}_${Math.round(this._pitchCents * 1000)}`;
    const measureBeats = Array.isArray(options.measureBeats) ? options.measureBeats : [];

    // Reuse cached note grouping data if notes haven't changed
    let beatMap, beatPositions, rests, getBeats;
    if (this._cachedNotes === notes && this._cachedBeatData) {
      ({ beatMap, beatPositions, rests, getBeats } = this._cachedBeatData);
    } else {
      getBeats = (n) => n.tiedBeats || n.durationBeats || ({
        whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25,
        '32nd': 0.125, dotted_whole: 6, dotted_half: 3, dotted_quarter: 1.5,
        dotted_eighth: 0.75, dotted_sixteenth: 0.375, dotted_32nd: 0.1875,
        dotted_dotted_whole: 7, dotted_dotted_half: 3.5, dotted_dotted_quarter: 1.75,
        dotted_dotted_eighth: 0.875, dotted_dotted_sixteenth: 0.4375, dotted_dotted_32nd: 0.21875,
      })[n.duration] || 1;

      const hasBeatOffset = notes.some(n => typeof n.beatOffset === 'number' && Number.isFinite(n.beatOffset));
      if (!hasBeatOffset) {
        this._voiceBuffers = null;
        this._voiceRenderKey = null;
        this._cachedNotes = null;
        this._cachedBeatData = null;
        this._beatMarkers = null;
        this._beatMarkersOnset = null;
        this._beatMarkersOnsetExternal = null;
        return null;
      }

      const canonicalNotes = collapseVoiceOnsets(assignPlaybackVoices(notes));
      const realNotes = canonicalNotes.filter(n => n.type !== 'rest' && n.midiNote != null);
      beatMap = new Map();
      for (const n of realNotes) {
        const bo = this._normalizeBeatOffset(n.beatOffset);
        if (!beatMap.has(bo)) beatMap.set(bo, []);
        beatMap.get(bo).push(n);
      }
      beatPositions = [...beatMap.keys()].sort((a, b) => a - b);
      rests = canonicalNotes.filter(n => n.type === 'rest' && typeof n.beatOffset === 'number');

      this._cachedNotes = notes;
      this._cachedBeatData = { beatMap, beatPositions, rests, getBeats };
    }

    // Build timing map (recalculated — depends on secondsPerBeat)
    const timingMap = [];
    for (const bo of beatPositions) {
      const group = beatMap.get(bo);
      const time = bo * secondsPerBeat;
      const avgX = group.reduce((s, n) => s + (n.x || 0), 0) / group.length;
      const avgY = group.reduce((s, n) => s + (n.y || 0), 0) / group.length;
      const voicePositions = group.map((n) => ({
        voice: resolvePlaybackVoice(n),
        x: Number.isFinite(n.x) ? n.x : avgX,
        y: Number.isFinite(n.y) ? n.y : avgY,
      }));
      timingMap.push({
        time,
        x: avgX,
        y: avgY,
        voicePositions,
        staffIndex: group[0].staffIndex,
        systemIndex: group[0].systemIndex ?? 0,
        isRest: false,
      });
    }
    for (const r of rests) {
      const rbo = this._normalizeBeatOffset(r.beatOffset);
      if (!beatMap.has(rbo)) {
        timingMap.push({ time: r.beatOffset * secondsPerBeat, x: r.x || 0, y: r.y || 0, staffIndex: r.staffIndex, systemIndex: r.systemIndex ?? 0, isRest: true });
      }
    }
    timingMap.sort((a, b) => a.time - b.time);

    // Compute total duration
    let totalDuration = 0;
    let totalBeats = 0;
    if (beatPositions.length > 0) {
      const lastBeat = beatPositions[beatPositions.length - 1];
      const lastGroup = beatMap.get(lastBeat);
      const maxBeats = Math.max(...lastGroup.map(getBeats));
      totalBeats = lastBeat + maxBeats;
      totalDuration = (lastBeat + maxBeats) * secondsPerBeat;
    }

    // Build per-voice audio buffers
    const tailSec = 0.3;
    const totalSamples = Math.floor((totalDuration + tailSec) * sampleRate);
    const voices = ['Soprano', 'Alto', 'Tenor', 'Bass'];
    const buffers = {};
    for (const v of voices) buffers[v] = new Float32Array(totalSamples);

    // Render each note into its voice buffer (fast: waveform cache handles synthesis)
    for (const bo of beatPositions) {
      const group = beatMap.get(bo);
      const offsetSamples = Math.floor(bo * secondsPerBeat * sampleRate);
      for (const n of group) {
        const voices = getPlaybackVoices(n);
        const renderVoices = voices.length > 0 ? voices : [resolvePlaybackVoice(n)];
        const dur = getBeats(n) * secondsPerBeat;
        const noteAudio = this.generatePianoNote(n.midiNote, dur);
        const start = offsetSamples;
        const len = Math.min(noteAudio.length, totalSamples - start);
        for (const voice of renderVoices) {
          const buf = buffers[voice] || buffers.Soprano;
          for (let i = 0; i < len; i++) buf[start + i] += noteAudio[i];
        }
      }
    }

    this._voiceBuffers = buffers;
    this._voiceTimingMap = timingMap;
    this._voiceTotalDuration = totalDuration;
    this._voiceRenderKey = renderKey;
    this._renderTempo = tempo;
    this._beatMarkers = this._buildBeatMarkers(measureBeats, totalBeats);
    this._beatMarkersOnset = this._buildOnsetBeatMarkers(beatPositions, measureBeats, totalBeats);

    console.log(`🎹 Pre-rendered 4 voice tracks (${(totalDuration).toFixed(1)}s, ${totalSamples} samples)`);
    return { timingMap, totalDuration };
  }

  /**
   * Mix selected voice buffers into a single WAV file.
   * This is near-instant since we're just adding pre-rendered Float32Arrays.
   *
   * @param {Object} voiceSelection - { Soprano: true/false, Alto: ..., Tenor: ..., Bass: ... }
   * @returns {{ fileUri, timingMap, totalDuration }}
   */
  static async mixVoiceTracks(voiceSelection) {
    if (!this._voiceBuffers) {
      throw new Error('Voice tracks not pre-rendered');
    }

    const sampleRate = 44100;
    const totalSamples = this._voiceBuffers.Soprano.length;
    const activeVoices = [];
    for (const [voice, active] of Object.entries(voiceSelection)) {
      if (active && this._voiceBuffers[voice]) activeVoices.push(voice);
    }

    // Pass 1: mix active voices + find peak in one loop
    const master = new Float32Array(totalSamples);
    let peak = 0;
    for (let i = 0; i < totalSamples; i++) {
      let sum = 0;
      for (const v of activeVoices) sum += this._voiceBuffers[v][i];
      if (!Number.isFinite(sum)) sum = 0;
      master[i] = sum;
      const abs = sum < 0 ? -sum : sum;
      if (abs > peak) peak = abs;
    }

    this._mixBeatGuide(master, 0, sampleRate, this._renderTempo || 120);

    // Recompute peak including beat guide so normalization stays safe and predictable.
    peak = 0;
    for (let i = 0; i < totalSamples; i++) {
      const abs = Math.abs(master[i]);
      if (abs > peak) peak = abs;
    }

    // Pass 2: normalize + encode to WAV PCM in one loop (Int16Array for speed)
    const scale = peak > 1 ? 1 / peak : 1;
    const bytesPerSample = 2;
    const subChunk2Size = totalSamples * bytesPerSample;
    const totalBytes = 44 + subChunk2Size;
    const wavBuffer = new ArrayBuffer(totalBytes);
    const view = new DataView(wavBuffer);

    // WAV header
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF');
    view.setUint32(4, 36 + subChunk2Size, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    ws(36, 'data');
    view.setUint32(40, subChunk2Size, true);

    // Encode PCM: normalize + write in one pass via Int16Array
    const pcm = new Int16Array(wavBuffer, 44, totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const s = master[i] * scale;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Write to reusable temp file
    const bytes = new Uint8Array(wavBuffer);
    const file = new File(Paths.cache, 'notescan_playback.wav');
    try { file.write(bytes); } catch (err) { console.error('❌ WAV write error:', err); throw err; }

    console.log(`🎹 Mixed ${activeVoices.join('+')} → WAV (${(totalBytes / 1024).toFixed(0)} KB)`);
    return {
      fileUri: file.uri,
      timingMap: this._voiceTimingMap,
      totalDuration: this._voiceTotalDuration,
    };
  }

  /**
   * Check if the voice tracks are pre-rendered and current.
   * Tempo is not part of the key — we use rate adjustment instead.
   */
  static hasPreRenderedTracks() {
    const expectedKey = `${this.getActivePresetIndex()}`;
    return this._voiceBuffers != null && this._voiceRenderKey === expectedKey;
  }

  /**
   * Legacy x-position-based audio generation (fallback when beatOffset is unavailable).
   */
  static async _createCombinedAudioLegacy(notes, tempo = 120, systemsMetadata = null) {
    const sampleRate = 44100;
    const secondsPerBeat = 60 / tempo;
    const durationMap = {
      whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25,
      '32nd': 0.125,
      dotted_whole: 6, dotted_half: 3, dotted_quarter: 1.5,
      dotted_eighth: 0.75, dotted_sixteenth: 0.375, dotted_32nd: 0.1875,
      dotted_dotted_whole: 7, dotted_dotted_half: 3.5, dotted_dotted_quarter: 1.75,
      dotted_dotted_eighth: 0.875, dotted_dotted_sixteenth: 0.4375, dotted_dotted_32nd: 0.21875,
    };

    // Sort notes: first by staff system, then x position
    const sorted = [...notes].sort((a, b) => {
      const sa = Number.isFinite(a.staffIndex) ? a.staffIndex : 999;
      const sb = Number.isFinite(b.staffIndex) ? b.staffIndex : 999;
      if (sa !== sb) return sa - sb;
      return (a.x || 0) - (b.x || 0);
    });

    // Build system mapping
    const staffToSystem = new Map();
    if (systemsMetadata && systemsMetadata.length > 0) {
      systemsMetadata.forEach((sys, idx) => {
        for (const si of sys.staffIndices) staffToSystem.set(si, idx);
      });
    } else {
      const staffIndices = [...new Set(sorted.map(n => n.staffIndex).filter(Number.isFinite))].sort((a, b) => a - b);
      let sysIdx = 0;
      for (let j = 0; j < staffIndices.length; j += 2) {
        staffToSystem.set(staffIndices[j], sysIdx);
        if (j + 1 < staffIndices.length) staffToSystem.set(staffIndices[j + 1], sysIdx);
        sysIdx++;
      }
    }

    const systemNotes = new Map();
    for (const note of sorted) {
      const sys = staffToSystem.get(note.staffIndex) ?? 0;
      if (!systemNotes.has(sys)) systemNotes.set(sys, []);
      systemNotes.get(sys).push(note);
    }

    const timingMap = [];
    const chordMeta = [];
    let globalTime = 0;

    const systems = [...systemNotes.entries()].sort((a, b) => a[0] - b[0]);

    for (const [, sysNotes] of systems) {
      sysNotes.sort((a, b) => (a.x || 0) - (b.x || 0));

      const xPositions = sysNotes.map(n => n.x || 0);
      const uniqueX = [...new Set(xPositions)].sort((a, b) => a - b);
      let colThreshold = 15;
      if (uniqueX.length > 2) {
        const gaps = [];
        for (let g = 1; g < uniqueX.length; g++) {
          const gap = uniqueX[g] - uniqueX[g - 1];
          if (gap > 2) gaps.push(gap);
        }
        if (gaps.length > 0) {
          gaps.sort((a, b) => a - b);
          const medianGap = gaps[Math.floor(gaps.length / 2)];
          colThreshold = Math.max(10, Math.min(30, Math.floor(medianGap * 0.4)));
        }
      }

      const columns = [];
      let col = [sysNotes[0]];
      for (let i = 1; i < sysNotes.length; i++) {
        const curr = sysNotes[i];
        const anchor = col[0];
        if (Math.abs((curr.x || 0) - (anchor.x || 0)) < colThreshold) {
          col.push(curr);
        } else {
          columns.push(col);
          col = [curr];
        }
      }
      columns.push(col);

      for (const col of columns) {
        const realNotes = col.filter(n => n.type !== 'rest');
        const isAllRests = realNotes.length === 0;
        const getBeats = (n) => n.tiedBeats || n.durationBeats || durationMap[n.duration] || 1;
        const minBeats = Math.min(...col.map(getBeats));
        const advanceDuration = minBeats * secondsPerBeat;
        const avgX = col.reduce((s, n) => s + (n.x || 0), 0) / col.length;
        const avgY = col.reduce((s, n) => s + (n.y || 0), 0) / col.length;
        const si = col[0].staffIndex;
        const voicePositions = col
          .filter(n => n.type !== 'rest')
          .map((n) => ({
            voice: n.voice,
            x: Number.isFinite(n.x) ? n.x : avgX,
            y: Number.isFinite(n.y) ? n.y : avgY,
          }));

        timingMap.push({
          time: globalTime,
          x: avgX,
          y: avgY,
          voicePositions,
          staffIndex: si,
          systemIndex: col[0].systemIndex ?? 0,
          isRest: isAllRests,
        });

        if (!isAllRests) {
          const noteEntries = realNotes.map(n => ({
            midiNote: n.midiNote ?? 60,
            dur: getBeats(n) * secondsPerBeat,
          }));
          chordMeta.push({ offsetSamples: Math.floor(globalTime * sampleRate), notes: noteEntries });
        }
        globalTime += advanceDuration;
      }
    }

    const tailSec = 0.3;
    const totalSamples = Math.floor((globalTime + tailSec) * sampleRate);
    const master = new Float32Array(totalSamples);

    for (const meta of chordMeta) {
      for (const n of meta.notes) {
        const noteAudio = this.generatePianoNote(n.midiNote, n.dur);
        const start = meta.offsetSamples;
        const len = Math.min(noteAudio.length, totalSamples - start);
        for (let i = 0; i < len; i++) master[start + i] += noteAudio[i];
      }
    }

    for (let i = 0; i < master.length; i++) {
      if (!Number.isFinite(master[i])) master[i] = 0;
    }
    let masterPeak = 0;
    for (let i = 0; i < master.length; i++) masterPeak = Math.max(masterPeak, Math.abs(master[i]));
    if (masterPeak > 1) for (let i = 0; i < master.length; i++) master[i] /= masterPeak;

    const fileUri = await this.writeWavToFile(master);
    console.log(`🎹 Combined audio (legacy x-pos): ${globalTime.toFixed(1)}s, ${timingMap.length} timing points`);
    return { fileUri, timingMap, totalDuration: globalTime };
  }

  /* ─── Playback control ─── */

  static _useWebAudio = false; // true when note events are prepared

  static async initAudio() {
    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
      });
    } catch (e) {
      console.warn('Audio init warning:', e);
    }
  }

  /**
   * Play using Web Audio API (event-based, instant tempo changes).
   * Called when note events are prepared.
   */
  static playWebAudio(tempo, voiceSelection, onPositionUpdate, onFinished) {
    this._stopQueue();

    const ctx = this._getAudioContext();
    if (!ctx) {
      console.warn('[AudioPlaybackService] Web Audio unavailable, cannot play via queue');
      return;
    }
    if (ctx.state === 'suspended') ctx.resume();

    this._onPositionUpdate = onPositionUpdate;
    this._onFinished = onFinished;
    this._currentTempo = tempo;
    this._renderTempo = tempo;
    this._voiceSelection = voiceSelection;
    this._mixCursor = 0;

    // Create single queue node
    this._queueNode = ctx.createBufferQueueSource();
    this._queueNode.connect(ctx.destination);

    this._playStartTime = ctx.currentTime;
    this._playStartOffset = 0;
    this._playbackLeadSec = this._getPlaybackLeadSec();

    // Feed initial chunks then start
    this._feedChunks();
    this._queueNode.start(0);
    this.isPlaying = true;
    this._useWebAudio = true;

    this._startFeedTimer();
    this._startPositionTracking(this._totalBeats * (60 / tempo));

    console.log(`▶️ Queue playback started at ${tempo} BPM`);
    return { totalDuration: this._totalBeats * (60 / tempo) };
  }

  /**
   * Play combined audio via expo-av (legacy fallback).
   * Calls `onPositionUpdate(timeSec)` ~60×/sec.
   * Calls `onFinished()` when playback completes.
   */
  static async play(fileUri, onPositionUpdate, onFinished) {
    await this.stop();

    if (!fileUri) {
      console.error('▶️ play() called with empty fileUri');
      if (onFinished) onFinished();
      return;
    }

    this._useWebAudio = false;
    this._tempFileUri = fileUri;
    console.log(`▶️ play(): loading ${fileUri}`);

    try {
      const { sound, status: initialStatus } = await Audio.Sound.createAsync(
        { uri: fileUri },
        { shouldPlay: true, progressUpdateIntervalMillis: 16 }
      );

      if (!initialStatus.isLoaded) {
        console.error('▶️ play(): sound not loaded after createAsync');
        if (onFinished) onFinished();
        return;
      }

      this.sound = sound;
      this.isPlaying = true;

      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) return;
        if (status.isPlaying && status.positionMillis != null) {
          if (onPositionUpdate) onPositionUpdate(status.positionMillis / 1000);
        }
        if (status.didJustFinish) {
          this.isPlaying = false;
          if (onFinished) onFinished();
        }
      });
    } catch (err) {
      console.error('▶️ play() error:', err);
      this.isPlaying = false;
      if (onFinished) onFinished();
    }
  }

  /** Return the tempo used when audio was last rendered / scheduled. */
  static getRenderTempo() {
    return this._renderTempo;
  }

  static async pause() {
    if (this._useWebAudio) {
      this._stopFeedTimer();
      this._stopPositionTracking();
      // Remember position for resume
      if (this._audioCtx) {
        this._playStartOffset = this._audioCtx.currentTime - this._playStartTime + this._playStartOffset;
      }
      if (this._queueNode) {
        try { this._queueNode.stop(); } catch (_) {}
        this._queueNode = null;
      }
      this.isPlaying = false;
      return;
    }
    if (this.sound) {
      try {
        const status = await this.sound.getStatusAsync();
        if (status.isLoaded && status.isPlaying) await this.sound.pauseAsync();
      } catch (e) { /* ignore */ }
    }
    this.isPlaying = false;
  }

  static async resume(voiceSelection) {
    if (this._useWebAudio) {
      if (this._noteEvents && voiceSelection) {
        const ctx = this._getAudioContext();
        if (ctx.state === 'suspended') ctx.resume();

        this._voiceSelection = voiceSelection;
        this._mixCursor = Math.floor(this._playStartOffset * 44100);
        this._playbackLeadSec = this._getPlaybackLeadSec();

        this._queueNode = ctx.createBufferQueueSource();
        this._queueNode.connect(ctx.destination);
        this._playStartTime = ctx.currentTime;
        this._feedChunks();
        this._queueNode.start(0);
        this.isPlaying = true;

        this._startFeedTimer();
        const remaining = this._totalBeats * (60 / this._currentTempo) - this._playStartOffset;
        this._startPositionTracking(remaining);
      }
      return;
    }
    if (this.sound) {
      try {
        const status = await this.sound.getStatusAsync();
        if (status.isLoaded && !status.isPlaying) {
          await this.sound.playAsync();
          this.isPlaying = true;
        }
      } catch (e) { /* ignore */ }
    }
  }

  static async stop() {
    // Web Audio path
    this._stopQueue();
    this._playStartOffset = 0;

    // expo-av path
    if (this.sound) {
      try {
        await this.sound.stopAsync();
        await this.sound.unloadAsync();
      } catch (e) { /* already unloaded */ }
      this.sound = null;
    }
    this.isPlaying = false;
  }

  static async seekTo(timeSeconds, voiceSelection) {
    if (this._useWebAudio && voiceSelection) {
      if (this.isPlaying && this._queueNode) {
        this._queueNode.clearBuffers();
        this._mixCursor = Math.floor(timeSeconds * 44100);
        this._playStartTime = this._getAudioContext().currentTime;
        this._playStartOffset = timeSeconds;
        this._voiceSelection = voiceSelection;
        this._feedChunks();
      } else {
        this._playStartOffset = timeSeconds;
      }
      return;
    }
    if (this.sound) {
      try {
        await this.sound.setPositionAsync(Math.floor(timeSeconds * 1000));
      } catch (e) { /* ignore */ }
    }
  }

  static getPlaybackPositionSec() {
    if (this._useWebAudio) {
      const ctx = this._getAudioContext();
      if (!ctx) return 0;
      return Math.max(0, ctx.currentTime - this._playStartTime + this._playStartOffset + this._playbackLeadSec);
    }
    return 0;
  }
}
