const CANONICAL_VOICES = ['Soprano', 'Alto', 'Tenor', 'Bass'];

function isCanonicalVoice(value) {
  return CANONICAL_VOICES.includes(String(value || ''));
}

function canonicalizeVoiceLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 's' || raw.includes('soprano')) return 'Soprano';
  if (raw === 'a' || raw.includes('alto')) return 'Alto';
  if (raw === 't' || raw.includes('tenor')) return 'Tenor';
  if (raw === 'b' || raw.includes('bass')) return 'Bass';
  return '';
}

function staffGroupForIndex(staffIndex) {
  if (!Number.isFinite(staffIndex)) return null;
  return Math.abs(Math.trunc(staffIndex)) % 2 === 0 ? 'upper' : 'lower';
}

function compareByGeometryThenPitch(a, b) {
  const ay = Number.isFinite(a?.y) ? a.y : null;
  const by = Number.isFinite(b?.y) ? b.y : null;
  if (ay != null && by != null && ay !== by) return ay - by;
  const am = Number.isFinite(a?.midiNote) ? a.midiNote : -Infinity;
  const bm = Number.isFinite(b?.midiNote) ? b.midiNote : -Infinity;
  if (am !== bm) return bm - am;
  const ax = Number.isFinite(a?.x) ? a.x : 0;
  const bx = Number.isFinite(b?.x) ? b.x : 0;
  return ax - bx;
}

function choosePrimaryNote(group) {
  const sorted = [...group].sort(compareByGeometryThenPitch);
  return sorted[0] || null;
}

function median(values) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (filtered.length === 0) return null;
  const mid = Math.floor(filtered.length / 2);
  if (filtered.length % 2 === 0) {
    return (filtered[mid - 1] + filtered[mid]) / 2;
  }
  return filtered[mid];
}

function getSourceVoice(note) {
  return canonicalizeVoiceLabel(note?.voice) || canonicalizeVoiceLabel(note?.playbackVoice) || '';
}

function setPlaybackVoices(note, voices, primaryVoice) {
  const uniqueVoices = [...new Set((Array.isArray(voices) ? voices : []).filter(Boolean))];
  note.playbackVoices = uniqueVoices;
  note.playbackVoice = primaryVoice || uniqueVoices[0] || note.playbackVoice || '';
}

function buildStaffThresholds(notes) {
  const upperYs = [];
  const lowerYs = [];
  for (const note of notes) {
    if (!Number.isFinite(note?.y)) continue;
    if (staffGroupForIndex(note?.staffIndex) === 'lower') {
      lowerYs.push(note.y);
    } else if (staffGroupForIndex(note?.staffIndex) === 'upper') {
      upperYs.push(note.y);
    }
  }
  return {
    upper: median(upperYs),
    lower: median(lowerYs),
  };
}

function inferVoiceFromY(note, staffGroup, thresholds) {
  const y = Number.isFinite(note?.y) ? note.y : null;
  if (!Number.isFinite(y)) return '';
  const threshold = staffGroup === 'lower' ? thresholds.lower : thresholds.upper;
  if (!Number.isFinite(threshold)) return '';
  if (staffGroup === 'upper') {
    return y <= threshold ? 'Soprano' : 'Alto';
  }
  return y <= threshold ? 'Tenor' : 'Bass';
}

function assignGroupVoices(group, staffGroup, thresholds) {
  const sorted = [...group].sort(compareByGeometryThenPitch);
  if (sorted.length === 0) return sorted;

  const sourceVoices = new Set(sorted.map((note) => getSourceVoice(note)).filter(Boolean));
  const primarySourceVoice = sourceVoices.size === 1 ? [...sourceVoices][0] : '';

  if (staffGroup === 'upper') {
    if (sorted.length === 1) {
      const soloVoice = primarySourceVoice || inferVoiceFromY(sorted[0], staffGroup, thresholds) || 'Soprano';
      setPlaybackVoices(sorted[0], [soloVoice], soloVoice);
      sorted[0].suppressPlayback = false;
      return sorted;
    }

    // Multiple notes at the same onset: keep outer notes as SATB voices.
    // This avoids collapsing both voices into one pitch when source voice labels are noisy.
    sorted.forEach((note, index) => {
      if (index === 0) {
        setPlaybackVoices(note, ['Soprano'], 'Soprano');
        note.suppressPlayback = false;
      } else if (index === sorted.length - 1) {
        setPlaybackVoices(note, ['Alto'], 'Alto');
        note.suppressPlayback = false;
      } else {
        note.playbackVoice = '';
        note.suppressPlayback = true;
      }
    });
    return sorted;
  }

  if (staffGroup === 'lower') {
    if (sorted.length === 1) {
      const soloVoice = primarySourceVoice || inferVoiceFromY(sorted[0], staffGroup, thresholds) || 'Bass';
      setPlaybackVoices(sorted[0], [soloVoice], soloVoice);
      sorted[0].suppressPlayback = false;
      return sorted;
    }

    // Multiple lower-staff notes: route top note to Tenor, bottom note to Bass.
    // Prevents duplicated/shared notes that can sound wrong when soloing voices.
    sorted.forEach((note, index) => {
      if (index === 0) {
        setPlaybackVoices(note, ['Tenor'], 'Tenor');
        note.suppressPlayback = false;
      } else if (index === sorted.length - 1) {
        setPlaybackVoices(note, ['Bass'], 'Bass');
        note.suppressPlayback = false;
      } else {
        note.playbackVoice = '';
        note.suppressPlayback = true;
      }
    });
    return sorted;
  }

  // Fallback: preserve explicit SATB labels when present, otherwise infer from geometry.
  const explicit = sorted.filter((note) => isCanonicalVoice(note.playbackVoice) || isCanonicalVoice(note.voice));
  if (explicit.length === sorted.length) {
    sorted.forEach((note) => {
      note.playbackVoice = isCanonicalVoice(note.playbackVoice)
        ? note.playbackVoice
        : canonicalizeVoiceLabel(note.voice) || 'Soprano';
    });
    return sorted;
  }

  if (sorted.length === 1) {
    sorted[0].playbackVoice = canonicalizeVoiceLabel(sorted[0].voice) || 'Soprano';
    return sorted;
  }

  sorted.forEach((note, index) => {
    if (isCanonicalVoice(note.voice)) {
      setPlaybackVoices(note, [note.voice], note.voice);
      note.suppressPlayback = false;
    } else {
      setPlaybackVoices(note, [index === 0 ? 'Soprano' : 'Alto'], index === 0 ? 'Soprano' : 'Alto');
      note.suppressPlayback = false;
    }
  });
  return sorted;
}

export function assignPlaybackVoices(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return [];

  const cloned = notes.map((note) => ({ ...note }));
  const thresholds = buildStaffThresholds(cloned);
  const groups = new Map();

  for (const note of cloned) {
    if (note.type === 'rest') {
      note.playbackVoice = note.playbackVoice || '';
      continue;
    }
    const beatKey = Number.isFinite(note.beatOffsetCanonical)
      ? note.beatOffsetCanonical
      : Number.isFinite(note.beatOffset)
        ? note.beatOffset
        : 0;
    const staffKey = Number.isFinite(note.staffIndex) ? note.staffIndex : 'x';
    const systemKey = Number.isFinite(note.systemIndex) ? note.systemIndex : 'x';
    const key = `${beatKey}|${staffKey}|${systemKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(note);
  }

  for (const group of groups.values()) {
    const staffIndex = Number.isFinite(group[0]?.staffIndex) ? group[0].staffIndex : null;
    const staffGroup = staffGroupForIndex(staffIndex);
    const assigned = assignGroupVoices(group, staffGroup, thresholds);
    for (const note of assigned) {
      if (!note.suppressPlayback) {
        if (!Array.isArray(note.playbackVoices) || note.playbackVoices.length === 0) {
          setPlaybackVoices(note, [canonicalizeVoiceLabel(note.voice) || 'Soprano'], canonicalizeVoiceLabel(note.voice) || 'Soprano');
        }
      }
    }
  }

  for (const note of cloned) {
    if (!note.suppressPlayback && !isCanonicalVoice(note.playbackVoice)) {
      note.playbackVoice = canonicalizeVoiceLabel(note.voice) || 'Soprano';
    }
  }

  return cloned;
}

export function collapseVoiceOnsets(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return [];

  const grouped = new Map();
  for (const note of notes) {
    if (!note || note.type === 'rest' || note.suppressPlayback) continue;
    const voice = resolvePlaybackVoice(note);
    if (!voice) continue;
    const beatKey = Number.isFinite(note.beatOffsetCanonical)
      ? note.beatOffsetCanonical
      : Number.isFinite(note.beatOffset)
        ? note.beatOffset
        : 0;
    const systemKey = Number.isFinite(note.systemIndex) ? note.systemIndex : 'x';
    const measureKey = Number.isFinite(note.measureNum) ? note.measureNum : 'x';
    const key = `${beatKey}|${voice}|${systemKey}|${measureKey}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(note);
  }

  const collapsed = [];
  const seen = new Set();
  for (const note of notes) {
    if (!note) {
      continue;
    }
    if (note.type === 'rest') {
      collapsed.push(note);
      continue;
    }
    if (note.suppressPlayback) {
      continue;
    }
    const voice = resolvePlaybackVoice(note);
    if (!voice) continue;
    const beatKey = Number.isFinite(note.beatOffsetCanonical)
      ? note.beatOffsetCanonical
      : Number.isFinite(note.beatOffset)
        ? note.beatOffset
        : 0;
    const systemKey = Number.isFinite(note.systemIndex) ? note.systemIndex : 'x';
    const measureKey = Number.isFinite(note.measureNum) ? note.measureNum : 'x';
    const key = `${beatKey}|${voice}|${systemKey}|${measureKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const winner = choosePrimaryNote(grouped.get(key) || [note]);
    if (winner) collapsed.push(winner);
  }

  return collapsed;
}

export function resolvePlaybackVoice(note) {
  if (!note) return 'Soprano';
  if (note.suppressPlayback) return '';
  return canonicalizeVoiceLabel(note.playbackVoice) || canonicalizeVoiceLabel(note.voice) || 'Soprano';
}

export function getPlaybackVoices(note) {
  if (!note || note.suppressPlayback) return [];
  const voices = Array.isArray(note.playbackVoices) ? note.playbackVoices : [];
  if (voices.length > 0) return [...new Set(voices.map(canonicalizeVoiceLabel).filter(Boolean))];
  const resolved = resolvePlaybackVoice(note);
  return resolved ? [resolved] : [];
}

export function noteMatchesVoiceSelection(note, voiceSelection) {
  if (!voiceSelection || Object.values(voiceSelection).every(Boolean)) return true;
  const voices = getPlaybackVoices(note);
  if (voices.length === 0) return false;
  return voices.some((voice) => !!voiceSelection[voice]);
}

export default {
  assignPlaybackVoices,
  collapseVoiceOnsets,
  resolvePlaybackVoice,
  getPlaybackVoices,
  noteMatchesVoiceSelection,
};