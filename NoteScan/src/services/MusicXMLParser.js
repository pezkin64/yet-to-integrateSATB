/**
 * MusicXML Parser
 *
 * Parses MusicXML returned by the OMR server into the note/rest format
 * expected by AudioPlaybackService and PlaybackScreen.
 *
 * Key improvement: properly tracks beat position using MusicXML's
 * <duration>, <backup>, <forward>, and <chord> elements so that
 * notes that should play simultaneously (e.g. treble + bass) get
 * the same beat offset.
 *
 * Output note format:
 *   { type, pitch, midiNote, duration, durationBeats, dotted, voice,
 *     staffIndex, systemIndex, measureIndex, accidental, tiedBeats,
 *     beatOffset }
 *
 * `beatOffset` is the absolute beat position (in quarter-note beats)
 * from the start of the piece. This drives correct audio timing —
 * notes with the same beatOffset play together.
 */

// Pitch name → semitone offset from C
const PITCH_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// MusicXML duration type → our duration name
const DURATION_TYPE_MAP = {
  'whole': 'whole',
  'half': 'half',
  'quarter': 'quarter',
  'eighth': 'eighth',
  '16th': 'sixteenth',
  '32nd': '32nd',
  '64th': '64th',
  'breve': 'whole',
};

// Duration name → beats (quarter-note beats)
const DURATION_BEATS = {
  'whole': 4, 'half': 2, 'quarter': 1, 'eighth': 0.5, 'sixteenth': 0.25,
  '32nd': 0.125, '64th': 0.0625,
  'dotted_whole': 6, 'dotted_half': 3, 'dotted_quarter': 1.5,
  'dotted_eighth': 0.75, 'dotted_sixteenth': 0.375, 'dotted_32nd': 0.1875,
};

// Voice number → voice name (fallback when staff info is unavailable)
const VOICE_NAMES = { 1: 'Soprano', 2: 'Alto', 3: 'Tenor', 4: 'Bass' };

/**
 * Map staff number + voice number → SATB voice name.
 * For piano/grand staff: treble (staff 1) → Soprano/Alto,
 *                        bass   (staff 2) → Tenor/Bass.
 * For multi-part: uses the global staff index to determine position.
 */
function staffVoiceToSATB(staffNum, voiceNum, stavesInPart, partClef = 'treble') {
  const clef = String(partClef || 'treble').toLowerCase();

  if (stavesInPart >= 2) {
    // Grand staff (piano, organ, etc.)
    // Staff 1 (treble): voice 1→Soprano, voice 2→Alto
    // Staff 2 (bass):   voice 1→Tenor,   voice 2→Bass
    if (staffNum <= 1) {
      return voiceNum <= 1 ? 'Soprano' : 'Alto';
    } else {
      return voiceNum <= 1 ? 'Tenor' : 'Bass';
    }
  }

  // Single-staff parts still need clef-aware routing.
  // A bass-clef staff should map to Tenor/Bass; a treble-clef staff to Soprano/Alto.
  if (clef === 'bass') {
    return voiceNum <= 1 ? 'Tenor' : 'Bass';
  }
  if (clef === 'alto' || clef === 'tenor') {
    return voiceNum <= 1 ? 'Alto' : 'Bass';
  }

  // Single-staff part: use voice number directly
  return VOICE_NAMES[voiceNum] || VOICE_NAMES[((voiceNum - 1) % 4) + 1];
}

function rewritePartTimeSignature(xml, partId, beats, beatType) {
  if (!partId || !Number.isFinite(beats) || !Number.isFinite(beatType)) return xml;
  const escapedPartId = partId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const partRegex = new RegExp(
    `(<part\\s+id="${escapedPartId}"[^>]*>)([\\s\\S]*?)(<\\/part>)`,
    'i'
  );
  const replacementTime = `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`;

  return xml.replace(partRegex, (match, openTag, inner, closeTag) => {
    const updatedInner = inner.replace(/<time>([\s\S]*?)<\/time>/g, replacementTime);
    return `${openTag}${updatedInner}${closeTag}`;
  });
}

function buildDottedDurationName(baseName, dotCount) {
  if (!Number.isFinite(dotCount) || dotCount <= 0) return baseName;
  return `${'dotted_'.repeat(dotCount)}${baseName}`;
}

export class MusicXMLParser {
  /**
   * Parse a MusicXML string into notes and metadata.
   * @param {string} xml - raw MusicXML string
   * @param {{ strictMusicXml?: boolean, collapseTies?: boolean }} [options]
   * @returns {{ notes: Array, metadata: Object }}
   */
  static parse(xml, options = {}) {
    const strictMusicXml = !!options.strictMusicXml;
    const collapseTies = options.collapseTies !== undefined
      ? !!options.collapseTies
      : !strictMusicXml;

    const notes = [];
    const metadata = {
      title: '',
      staves: 0,
      systems: 0,
      timeSignature: { beats: 4, beatType: 4 },
      keySignature: { type: 'None', count: 0 },
      clefs: [],
      stavesPerSystem: 2,
    };

    // Extract title
    const titleMatch = xml.match(/<work-title>([^<]*)<\/work-title>/) ||
                       xml.match(/<movement-title>([^<]*)<\/movement-title>/);
    if (titleMatch) metadata.title = titleMatch[1].trim();

    // Extract part IDs
    const partIds = [];
    for (const m of xml.matchAll(/<score-part\s+id="([^"]+)"/g)) {
      partIds.push(m[1]);
    }
    if (partIds.length === 0) {
      for (const m of xml.matchAll(/<part\s+id="([^"]+)"/g)) {
        if (!partIds.includes(m[1])) partIds.push(m[1]);
      }
    }

    // Parse each part
    let globalStaffOffset = 0;
    let systemIndex = 0;
    let globalBeatOffset = 0; // Absolute beat position across all measures
    const partMeterOverrides = [];

    for (let partIdx = 0; partIdx < partIds.length; partIdx++) {
      const partId = partIds[partIdx];
      const partRegex = new RegExp(
        `<part\\s+id="${partId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)<\\/part>`,
        'i'
      );
      const partMatch = xml.match(partRegex);
      if (!partMatch) continue;

      const measures = this._extractMeasures(partMatch[1]);

      let divisions = 1; // divisions per quarter note
      let currentKey = { fifths: 0 };
      let currentTime = { beats: 4, beatType: 4 };
      let hasExplicitTimeSignature = false;
      let partTimeSignatureForMetadata = null;
      let currentClefs = {};
      let stavesInPart = 1;
      let measureIndex = -1;
      const trimmedMeasures = [];
      globalBeatOffset = 0;

      for (const measureXml of measures) {
        measureIndex++;
        const measureNumber = measureXml.match(/<measure\b[^>]*\bnumber="([^"]+)"/)?.[1] || String(measureIndex + 1);

        // Check for new system
        if (measureIndex > 0 &&
            (/<print[^>]*new-system="yes"/.test(measureXml) ||
             /<print[^>]*new-page="yes"/.test(measureXml))) {
          systemIndex++;
        }

        // Parse ALL <attributes> blocks in this measure (there can be multiple)
        for (const attrM of measureXml.matchAll(/<attributes>([\s\S]*?)<\/attributes>/g)) {
          const attr = attrM[1];

          const divM = attr.match(/<divisions>(\d+)<\/divisions>/);
          if (divM) divisions = parseInt(divM[1]);

          const keyM = attr.match(/<key>([\s\S]*?)<\/key>/);
          if (keyM) {
            const fifths = parseInt(keyM[1].match(/<fifths>(-?\d+)<\/fifths>/)?.[1] || '0');
            currentKey = { fifths };
          }

          const timeM = attr.match(/<time>([\s\S]*?)<\/time>/);
          if (timeM) {
            const beats = parseInt(timeM[1].match(/<beats>(\d+)<\/beats>/)?.[1] || '4');
            const beatType = parseInt(timeM[1].match(/<beat-type>(\d+)<\/beat-type>/)?.[1] || '4');
            currentTime = { beats, beatType };
            hasExplicitTimeSignature = true;
          }

          const stavesM = attr.match(/<staves>(\d+)<\/staves>/);
          if (stavesM) stavesInPart = parseInt(stavesM[1]);

          for (const cm of attr.matchAll(/<clef[^>]*(?:number="(\d+)")?[^>]*>([\s\S]*?)<\/clef>/g)) {
            const clefNum = cm[1] ? parseInt(cm[1]) : 1;
            const sign = cm[2].match(/<sign>(\w)<\/sign>/)?.[1] || 'G';
            currentClefs[clefNum] = sign === 'G' ? 'treble' : sign === 'F' ? 'bass' : sign === 'C' ? 'alto' : 'treble';
            // Auto-detect stavesInPart from clef numbers (OMR engines sometimes omit <staves>)
            if (clefNum > stavesInPart) stavesInPart = clefNum;
          }

          // Also auto-detect from staff numbers used in this measure's notes
          for (const sm of measureXml.matchAll(/<staff>(\d+)<\/staff>/g)) {
            const sn = parseInt(sm[1]);
            if (sn > stavesInPart) stavesInPart = sn;
          }
        }

        // ─── Parse note/rest/backup/forward events IN DOCUMENT ORDER ───
        // Track beat position PER VOICE within the measure.
        // Some OMR engines interleave staves without <backup> elements,
        // so when a note switches to a different voice/staff, we must
        // track each voice independently to avoid treating concurrent
        // notes as sequential.
        const measureStartBeat = globalBeatOffset;
        let measureHasRest = false;

        // voiceBeatPos: Map<"staff_voice" → current beat position in measure>
        const voiceBeatPos = new Map();
        // lastOnsetByVoice: Map<"staff_voice" → last non-chord note onset in measure>
        const lastOnsetByVoice = new Map();
        // "active" voice key — tracks which voice the linear position belongs to
        let activeVoiceKey = null;
        // Fallback linear position (used for backup/forward which are voice-independent)
        let linearBeatPos = 0;

        const getVoiceKey = (staffNum, voiceNum) => `${staffNum}_${voiceNum}`;

        // Match all relevant elements in document order
        const eventRegex = /<(note|backup|forward)\b[^>]*>([\s\S]*?)<\/\1>/g;
        let em;
        while ((em = eventRegex.exec(measureXml)) !== null) {
          const tag = em[1];
          const content = em[2];

          if (tag === 'backup') {
            const durDivs = parseInt(content.match(/<duration>(\d+)<\/duration>/)?.[1] || '0');
            const beats = durDivs / divisions;
            linearBeatPos -= beats;
            if (linearBeatPos < 0) linearBeatPos = 0;
            // Reset active voice — next note determines the voice
            activeVoiceKey = null;
            continue;
          }

          if (tag === 'forward') {
            const durDivs = parseInt(content.match(/<duration>(\d+)<\/duration>/)?.[1] || '0');
            const beats = durDivs / divisions;

            const forwardStaff = Number.parseInt(content.match(/<staff>(\d+)<\/staff>/)?.[1] ?? '', 10);
            const forwardVoice = Number.parseInt(content.match(/<voice>(\d+)<\/voice>/)?.[1] ?? '', 10);
            const hasForwardContext = Number.isFinite(forwardStaff) && forwardStaff > 0 &&
              Number.isFinite(forwardVoice) && forwardVoice > 0;

            let targetVoiceKey = null;
            if (hasForwardContext) {
              targetVoiceKey = getVoiceKey(forwardStaff, forwardVoice);
            } else if (activeVoiceKey && voiceBeatPos.has(activeVoiceKey)) {
              targetVoiceKey = activeVoiceKey;
            }

            linearBeatPos += beats;

            // Apply forward movement to the targeted voice timeline when known.
            if (targetVoiceKey) {
              const basePos = voiceBeatPos.has(targetVoiceKey)
                ? voiceBeatPos.get(targetVoiceKey)
                : Math.max(0, linearBeatPos - beats);
              voiceBeatPos.set(targetVoiceKey, basePos + beats);
              activeVoiceKey = targetVoiceKey;
            }
            continue;
          }

          // It's a <note>
          const noteXml = content;
          const isChord = /<chord\s*\/>/.test(noteXml);
          const isRest = /<rest\s*\/>/.test(noteXml) || /<rest>/.test(noteXml);
          const xmlId = noteXml.match(/\b(?:xml:id|id)="([^"]+)"/i)?.[1] || null;

          // Duration in divisions → quarter-note beats
          const durationDivs = parseInt(noteXml.match(/<duration>(\d+)<\/duration>/)?.[1] || String(divisions));
          const durationBeats = durationDivs / divisions;

          // Type name
          const typeStr = noteXml.match(/<type>([^<]+)<\/type>/)?.[1] || '';
          const durName = DURATION_TYPE_MAP[typeStr] || this._beatsToType(durationBeats);

          // Dotted?
          const dotCount = (noteXml.match(/<dot\s*\/?\s*>/g) || []).length;
          const dotted = dotCount > 0;
          const fullDurName = buildDottedDurationName(durName, dotCount);

          // Staff and voice
          const staffNum = parseInt(noteXml.match(/<staff>(\d+)<\/staff>/)?.[1] || '1');
          const staffIdx = globalStaffOffset + staffNum - 1;
          const voiceNum = parseInt(noteXml.match(/<voice>(\d+)<\/voice>/)?.[1] || '1');
          const activeClef = currentClefs[staffNum] || currentClefs[1] || Object.values(currentClefs)[0] || 'treble';
          const voiceName = staffVoiceToSATB(staffNum, voiceNum, stavesInPart, activeClef);
          const vKey = getVoiceKey(staffNum, voiceNum);

          // Initialize voice position on first encounter
          if (!voiceBeatPos.has(vKey)) {
            // Each voice/staff starts at the BEGINNING of the measure (beat 0).
            // OMR engines may interleave notes from different staves without <backup>
            // elements, so we can't use the linear (cumulative) position.
            // For proper MusicXML with <backup>, the backup resets
            // linearBeatPos to 0 anyway, so starting at 0 is correct either way.
            voiceBeatPos.set(vKey, 0);
          }

          activeVoiceKey = vKey;

          // Get this voice's current beat position
          let voicePos = voiceBeatPos.get(vKey);

          // Compute beat offset for this note
          let noteBeatOffset;
          if (isChord) {
            // Chord: same onset as the previous note in this voice.
            // Do not derive onset by subtracting the CURRENT chord note duration,
            // because OMR can emit inconsistent duration/type for chord members.
            const lastOnset = lastOnsetByVoice.get(vKey);
            if (Number.isFinite(lastOnset)) {
              noteBeatOffset = measureStartBeat + lastOnset;
            } else {
              // Fallback for malformed input where a chord appears before a base note.
              noteBeatOffset = measureStartBeat + Math.max(0, voicePos - durationBeats);
            }
          } else {
            noteBeatOffset = measureStartBeat + voicePos;
          }

          // Ties
          const tieStart = /<(?:tie|tied)\b[^>]*\btype="start"[^>]*\/?\s*>/.test(noteXml);
          const tieStop = /<(?:tie|tied)\b[^>]*\btype="stop"[^>]*\/?\s*>/.test(noteXml);

          if (isRest) {
            measureHasRest = true;
            notes.push({
              type: 'rest',
              partIndex: partIdx,
              xmlId,
              pitch: null,
              midiNote: null,
              duration: fullDurName,
              durationBeats,
              dotted,
              voice: voiceName,
              staffIndex: staffIdx,
              systemIndex,
              measureIndex,
              accidental: null,
              tiedBeats: null,
              beatOffset: noteBeatOffset,
            });
          } else {
            // Parse pitch
            const pitchMatch = noteXml.match(/<pitch>([\s\S]*?)<\/pitch>/);
            if (pitchMatch) {
              const pitchXml = pitchMatch[1];
              const step = pitchXml.match(/<step>([A-G])<\/step>/)?.[1] || 'C';
              const octave = parseInt(pitchXml.match(/<octave>(\d+)<\/octave>/)?.[1] || '4');
              const alter = parseInt(pitchXml.match(/<alter>(-?\d+)<\/alter>/)?.[1] || '0');
              const midiNote = this._pitchToMidi(step, octave, alter);
              const pitchName = `${step}${alter > 0 ? '#' : alter < 0 ? 'b' : ''}${octave}`;

              let accidental = null;
              const accMatch = noteXml.match(/<accidental>([^<]+)<\/accidental>/);
              if (accMatch) {
                accidental = accMatch[1] === 'sharp' ? 'sharp'
                  : accMatch[1] === 'flat' ? 'flat'
                  : accMatch[1] === 'natural' ? 'natural' : null;
              }

              notes.push({
                type: 'note',
                partIndex: partIdx,
                xmlId,
                pitch: pitchName,
                midiNote,
                duration: fullDurName,
                durationBeats,
                dotted,
                voice: voiceName,
                staffIndex: staffIdx,
                systemIndex,
                measureIndex,
                accidental,
                tiedBeats: null,
                beatOffset: noteBeatOffset,
                _tieStart: tieStart,
                _tieStop: tieStop,
              });
            }
          }

          // Advance this voice's beat position (only for non-chord notes)
          if (!isChord) {
            lastOnsetByVoice.set(vKey, voicePos);
            voiceBeatPos.set(vKey, voicePos + durationBeats);
            // Also update linear position to track the furthest point
            linearBeatPos = Math.max(linearBeatPos, voiceBeatPos.get(vKey));
          }
        }

        // Advance global beat offset by this measure's duration.
        // Pickup/anacrusis detection: if the first measure has less content
        // than the time signature suggests, use the actual content duration
        // to avoid a large silence gap at the start.
        const theoreticalBeats = currentTime.beats * (4 / currentTime.beatType);
        const maxVoicePos = voiceBeatPos.size > 0
          ? Math.max(...voiceBeatPos.values())
          : 0;
        const looksOverPadded =
          !measureHasRest &&
          maxVoicePos > 0 &&
          theoreticalBeats > (maxVoicePos * 1.5) &&
          (theoreticalBeats - maxVoicePos) >= 1;
        let measureBeats;
        if (measureIndex === 0 && maxVoicePos > 0 && maxVoicePos < theoreticalBeats) {
          // Pickup measure — use actual content duration
          measureBeats = maxVoicePos;
        } else if (looksOverPadded) {
          // OMR can emit over-large meter relative to measured note spans.
          // If there are no explicit rests and the gap is significant,
          // use actual content span to avoid long playback silences.
          measureBeats = maxVoicePos;
          trimmedMeasures.push({
            measureNumber,
            theoreticalBeats,
            contentBeats: maxVoicePos,
            explicitTime: hasExplicitTimeSignature,
          });
        } else {
          // Normal measure — use theoretical, or actual if content overflows
          measureBeats = Math.max(theoreticalBeats, maxVoicePos);
        }
        globalBeatOffset += measureBeats;
      }

      if (trimmedMeasures.length > 0) {
        if (trimmedMeasures.length <= 4) {
          for (const tm of trimmedMeasures) {
            console.warn(
              `⏱️ Trimmed padded measure ${tm.measureNumber} (part ${partId}${tm.explicitTime ? ', explicit-time' : ''}): ` +
              `theoretical=${tm.theoreticalBeats.toFixed(2)} beats, content=${tm.contentBeats.toFixed(2)} beats`
            );
          }
        } else {
          const sample = trimmedMeasures
            .slice(0, 5)
            .map(tm => `${tm.measureNumber}:${tm.theoreticalBeats.toFixed(2)}→${tm.contentBeats.toFixed(2)}`)
            .join(', ');
          console.warn(
            `⏱️ Trimmed padded measures in part ${partId}${trimmedMeasures[0].explicitTime ? ' (explicit-time)' : ''}: ` +
            `${trimmedMeasures.length} measures adjusted; sample=${sample}`
          );
        }
      }

      // If explicit time is repeatedly over-padded across most measures,
      // infer a practical display meter from actual content spans.
      if (
        hasExplicitTimeSignature &&
        (
          trimmedMeasures.length >= Math.max(4, Math.floor(measures.length * 0.33)) ||
          (currentTime.beats >= 9 && trimmedMeasures.length >= 2)
        )
      ) {
        const sortedContent = trimmedMeasures
          .map(tm => tm.contentBeats)
          .sort((a, b) => a - b);
        const mid = Math.floor(sortedContent.length / 2);
        const medianContent = sortedContent.length % 2 === 0
          ? (sortedContent[mid - 1] + sortedContent[mid]) / 2
          : sortedContent[mid];

        const inferredQuarterBeats = Math.max(1, Math.round(medianContent * 2) / 2);
        const isIntegerQuarter = Math.abs(inferredQuarterBeats - Math.round(inferredQuarterBeats)) < 0.001;

        partTimeSignatureForMetadata = isIntegerQuarter
          ? { beats: Math.round(inferredQuarterBeats), beatType: 4 }
          : { beats: Math.round(inferredQuarterBeats * 2), beatType: 8 };

        partMeterOverrides.push({
          partId,
          beats: partTimeSignatureForMetadata.beats,
          beatType: partTimeSignatureForMetadata.beatType,
        });

        console.warn(
          `⏱️ Meter override for part ${partId}: exported=${currentTime.beats}/${currentTime.beatType}, ` +
          `inferred=${partTimeSignatureForMetadata.beats}/${partTimeSignatureForMetadata.beatType} ` +
          `(trimmed ${trimmedMeasures.length}/${measures.length} measures)`
        );
      }

      // Update global staff offset for next part
      globalStaffOffset += stavesInPart;

      // Update metadata
      if (metadata.clefs.length === 0) {
        for (const [, clef] of Object.entries(currentClefs)) {
          metadata.clefs.push(clef);
        }
      }
      metadata.timeSignature = partTimeSignatureForMetadata || currentTime;
      metadata.keySignature = this._fifthsToKey(currentKey.fifths);
    }

    // Resolve ties unless strict literal parsing is requested.
    if (collapseTies) {
      this._resolveTies(notes);
    }

    let adjustedMusicXml = xml;
    for (const override of partMeterOverrides) {
      adjustedMusicXml = rewritePartTimeSignature(
        adjustedMusicXml,
        override.partId,
        override.beats,
        override.beatType
      );
    }

    metadata.systems = Math.max(1, systemIndex + 1);
    metadata.staves = globalStaffOffset;
    metadata.stavesPerSystem = globalStaffOffset > 0
      ? Math.max(1, Math.round(globalStaffOffset / metadata.systems))
      : 2;
    metadata.totalBeats = globalBeatOffset;

    const noteCount = notes.filter(n => n.type === 'note').length;
    const restCount = notes.filter(n => n.type === 'rest').length;
    metadata.totalRests = restCount;

    // Count per-voice for diagnostics
    const voiceCounts = {};
    for (const n of notes) {
      if (n.type === 'note') voiceCounts[n.voice] = (voiceCounts[n.voice] || 0) + 1;
    }

    // Check whether SATB assignment should be rebalanced.
    // Typical trigger: 2+ SATB voices are empty (all notes collapsed to one/two voices).
    // Additional trigger: severe imbalance, e.g. S=113, A=17, T=1, B=0.
    // In both cases, redistribute with a hybrid per-beat + quartile approach:
    //   • Beats with 2+ simultaneous notes: top→S, next→A, next→T, bottom→B
    //   • Beats with only 1 note: index-based quartile fallback
    const allFourVoices = ['Soprano', 'Alto', 'Tenor', 'Bass'];
    const emptyVoices = allFourVoices.filter(v => !voiceCounts[v]);
    const nonZeroCounts = Object.values(voiceCounts).filter(c => c > 0);
    const maxVoiceCount = nonZeroCounts.length > 0 ? Math.max(...nonZeroCounts) : 0;
    const minVoiceCount = nonZeroCounts.length > 0 ? Math.min(...nonZeroCounts) : 0;
    const dominantVoiceShare = noteCount > 0 ? (maxVoiceCount / noteCount) : 0;
    const severeImbalance = nonZeroCounts.length >= 2 && (
      dominantVoiceShare >= 0.70 ||
      maxVoiceCount >= (minVoiceCount * 3)
    );

    const shouldRedistributeVoices =
      (emptyVoices.length >= 2 || severeImbalance) &&
      noteCount > 1 &&
      Object.keys(voiceCounts).length <= 1;

    if (shouldRedistributeVoices) {
      if (severeImbalance && emptyVoices.length < 2) {
        console.log(
          `🎤 SATB imbalance detected: max=${maxVoiceCount}, min=${minVoiceCount}, ` +
          `dominant=${(dominantVoiceShare * 100).toFixed(1)}%`
        );
      }
      const pitched = notes.filter(n => n.type === 'note' && n.midiNote != null);
      const total = pitched.length;

      if (total >= 2) {

        // ── Step 1: Group notes by beatOffset (simultaneous notes) ──
        const beatGroups = new Map(); // beatOffset → [note, note, ...]
        for (const n of pitched) {
          const key = n.beatOffset.toFixed(4); // avoid float key issues
          if (!beatGroups.has(key)) beatGroups.set(key, []);
          beatGroups.get(key).push(n);
        }

        // ── Step 2: Per-beat assignment for chords (2+ notes at same beat) ──
        const upperVoiceOrder = ['Soprano', 'Alto', 'Tenor', 'Bass'];
        // Lower staff should stay anchored to Tenor/Bass first.
        // Putting Alto here causes the exact voice swapping the user reported.
        const lowerVoiceOrder = ['Tenor', 'Bass', 'Alto', 'Soprano'];
        const staffMidpoint = Math.max(0, (metadata.staves - 1) / 2);
        const singleNotes = []; // notes alone on their beat — handled in step 3

        for (const [, group] of beatGroups) {
          if (group.length >= 2) {
            // Sort highest pitch first and assign by staff region.
            // Upper staff prefers S/A; lower staff prefers T/B.
            group.sort((a, b) => b.midiNote - a.midiNote);
            const avgStaff = group.reduce((sum, n) => sum + (Number.isFinite(n.staffIndex) ? n.staffIndex : staffMidpoint), 0) / group.length;
            const preferredOrder = avgStaff > staffMidpoint ? lowerVoiceOrder : upperVoiceOrder;
            group.forEach((n, i) => {
              n.voice = preferredOrder[Math.min(i, 3)];
            });
          } else {
            singleNotes.push(group[0]);
          }
        }

        // ── Step 3: Quartile fallback for single-note beats ──
        if (singleNotes.length > 0) {
          // Staff-aware single-note assignment:
          // upper-staff singles split between Alto/Soprano,
          // lower-staff singles split between Bass/Tenor.
          const upperSingles = [];
          const lowerSingles = [];

          for (const n of singleNotes) {
            const sIdx = Number.isFinite(n.staffIndex) ? n.staffIndex : staffMidpoint;
            if (sIdx > staffMidpoint) lowerSingles.push(n);
            else upperSingles.push(n);
          }

          const assignBiased = (arr, lowVoice, highVoice, lowShare) => {
            if (arr.length === 0) return;
            arr.sort((a, b) => a.midiNote - b.midiNote);
            const split = Math.floor(arr.length * lowShare);
            for (let i = 0; i < arr.length; i++) {
              arr[i].voice = i < split ? lowVoice : highVoice;
            }
          };

          // Bias toward inner/upper voices for single notes.
          // Lower singles: keep fewer in Bass to avoid Bass domination.
          // Upper singles: keep fewer in Alto to lift Soprano count.
          assignBiased(lowerSingles, 'Bass', 'Tenor', 0.20);
          assignBiased(upperSingles, 'Alto', 'Soprano', 0.35);

          // Final safety fallback for any uncategorized single note.
          const unassigned = singleNotes.filter(n => !n.voice);
          if (unassigned.length > 0) {
            const sortedSingles = [...unassigned].sort((a, b) => a.midiNote - b.midiNote);
            const n = sortedSingles.length;
            const q1_idx = Math.floor(n * 0.25);
            const q2_idx = Math.floor(n * 0.50);
            const q3_idx = Math.floor(n * 0.75);
            for (let i = 0; i < n; i++) {
              if (i < q1_idx) sortedSingles[i].voice = 'Bass';
              else if (i < q2_idx) sortedSingles[i].voice = 'Tenor';
              else if (i < q3_idx) sortedSingles[i].voice = 'Alto';
              else sortedSingles[i].voice = 'Soprano';
            }
          }
        }

        const chordBeats = [...beatGroups.values()].filter(g => g.length >= 2).length;
        console.log(`🎤 Hybrid SATB: ${chordBeats} chord beats (per-beat), ${singleNotes.length} single notes (quartile) across ${total} total`);
      } else {
        // Only 1 pitched note — assign Soprano
        pitched[0].voice = 'Soprano';
      }

      // Recount from scratch
      for (const k of Object.keys(voiceCounts)) delete voiceCounts[k];
      for (const n of notes) {
        if (n.type === 'note') voiceCounts[n.voice] = (voiceCounts[n.voice] || 0) + 1;
      }
      console.log(`🎤 After redistribution:`, JSON.stringify(voiceCounts));
    }

    // Always correct same-beat, same-staff chord clusters.
    // This is the important SATB fix for scores that encode both notes in one voice.
    const chordGroups = new Map();
    const pitchedNotes = notes.filter((n) => n.type === 'note' && n.midiNote != null && Number.isFinite(n.beatOffset));
    const staffChordAssignments = { upper: 0, lower: 0 };
    const upperOrder = ['Soprano', 'Alto', 'Tenor', 'Bass'];
    const lowerOrder = ['Tenor', 'Bass', 'Alto', 'Soprano'];
    const chordStaffMidpoint = Math.max(0, (metadata.staves - 1) / 2);

    for (const n of pitchedNotes) {
      const beatKey = this._normalizeBeatOffset ? this._normalizeBeatOffset(n.beatOffset) : Math.round(n.beatOffset * 10000) / 10000;
      const staffKey = Number.isFinite(n.staffIndex) ? n.staffIndex : -1;
      const systemKey = Number.isFinite(n.systemIndex) ? n.systemIndex : -1;
      const key = `${beatKey}|${staffKey}|${systemKey}`;
      if (!chordGroups.has(key)) chordGroups.set(key, []);
      chordGroups.get(key).push(n);
    }

    for (const group of chordGroups.values()) {
      if (group.length < 2) continue;

      group.sort((a, b) => {
        const ay = Number.isFinite(a.y) ? a.y : null;
        const by = Number.isFinite(b.y) ? b.y : null;
        if (ay != null && by != null && ay !== by) return ay - by;
        return b.midiNote - a.midiNote;
      });

      const avgStaff = group.reduce((sum, n) => sum + (Number.isFinite(n.staffIndex) ? n.staffIndex : chordStaffMidpoint), 0) / group.length;
      const voiceOrder = avgStaff > chordStaffMidpoint ? lowerOrder : upperOrder;

      for (let i = 0; i < group.length; i++) {
        group[i].voice = voiceOrder[Math.min(i, voiceOrder.length - 1)];
      }

      if (avgStaff > chordStaffMidpoint) staffChordAssignments.lower += 1;
      else staffChordAssignments.upper += 1;
    }

    if (staffChordAssignments.upper > 0 || staffChordAssignments.lower > 0) {
      console.log(
        `🎼 SATB chord pass: upper=${staffChordAssignments.upper}, lower=${staffChordAssignments.lower} chord groups reassigned`
      );
    }

    metadata.voiceCounts = voiceCounts;

    // Note range (lowest / highest MIDI and pitch names)
    const realNotes = notes.filter(n => n.type === 'note' && n.midiNote != null);
    if (realNotes.length > 0) {
      const sorted = [...realNotes].sort((a, b) => a.midiNote - b.midiNote);
      metadata.noteRange = {
        low: { midi: sorted[0].midiNote, pitch: sorted[0].pitch },
        high: { midi: sorted[sorted.length - 1].midiNote, pitch: sorted[sorted.length - 1].pitch },
      };
    }

    // Measure info: total count + array of beat boundaries for progress bar
    metadata.totalMeasures = 0;
    metadata.measureBeats = []; // [{ measureNum, startBeat, endBeat, beats, beatType }]

    // Re-derive from the part(s) - walk first part's measures to build boundaries
    if (partIds.length > 0) {
      const firstPartId = partIds[0];
      const firstPartRegex = new RegExp(
        `<part\\s+id="${firstPartId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)<\\/part>`,
        'i'
      );
      const firstPartMatch = xml.match(firstPartRegex);
      if (firstPartMatch) {
        const measures = this._extractMeasures(firstPartMatch[1]);
        let mDivisions = 1;
        let mTime = { beats: 4, beatType: 4 };
        let mBeatOffset = 0;

        for (let mi = 0; mi < measures.length; mi++) {
          const mXml = measures[mi];
          // Check for attributes in this measure
          for (const attrM of mXml.matchAll(/<attributes>([\s\S]*?)<\/attributes>/g)) {
            const attr = attrM[1];
            const divM = attr.match(/<divisions>(\d+)<\/divisions>/);
            if (divM) mDivisions = parseInt(divM[1]);
            const timeM = attr.match(/<time>([\s\S]*?)<\/time>/);
            if (timeM) {
              mTime = {
                beats: parseInt(timeM[1].match(/<beats>(\d+)<\/beats>/)?.[1] || '4'),
                beatType: parseInt(timeM[1].match(/<beat-type>(\d+)<\/beat-type>/)?.[1] || '4'),
              };
            }
          }
          const measureBeats = mTime.beats * (4 / mTime.beatType);
          const num = parseInt(mXml.match(/<measure[^>]*number="(\d+)"/)?.[1] || String(mi + 1));
          metadata.measureBeats.push({
            measureNum: num,
            startBeat: mBeatOffset,
            endBeat: mBeatOffset + measureBeats,
            beats: mTime.beats,
            beatType: mTime.beatType,
          });
          mBeatOffset += measureBeats;
        }
        metadata.totalMeasures = measures.length;
      }
    }

    // Extract tempo from <sound tempo="..."/>.
    // Prefer the last declared tempo and reject unrealistic OMR calibration values.
    const tempoMatches = [...xml.matchAll(/<sound[^>]*\btempo="([\d.]+)"/g)];
    let selectedTempo = tempoMatches.length > 0
      ? parseFloat(tempoMatches[tempoMatches.length - 1][1])
      : null;

    if (!Number.isFinite(selectedTempo) || selectedTempo < 40 || selectedTempo > 240) {
      // Fallback: 120 BPM for malformed/unrealistic tempos (e.g., 8 BPM).
      selectedTempo = 120;
    }

    metadata.tempo = Math.round(selectedTempo);

    // Rewrite all tempo tags to use the validated tempo (fixes incorrect/broken tempos like 8 BPM from OMR)
    let correctedMusicXml = adjustedMusicXml
      // Fix <sound tempo="..."/>
      .replace(/<sound[^>]*\btempo="[\d.]+"/g, `<sound tempo="${metadata.tempo}"`)
      // Fix <per-minute>...</per-minute> inside metronome
      .replace(/<per-minute>[\d.]+<\/per-minute>/g, `<per-minute>${metadata.tempo}</per-minute>`);

    console.log(
      `✅ Parsed MusicXML: ${noteCount} notes, ${restCount} rests, ` +
      `${metadata.staves} staves, ${metadata.systems} systems, ` +
      `${metadata.totalMeasures} measures, ${globalBeatOffset} total beats\n` +
      `   Voice distribution: ${Object.entries(voiceCounts).map(([v,c]) => `${v}=${c}`).join(', ')}` +
      (metadata.noteRange ? `\n   Range: ${metadata.noteRange.low.pitch} – ${metadata.noteRange.high.pitch}` : '') +
      (metadata.tempo ? `\n   Tempo: ${metadata.tempo} BPM` : '')
    );

    return { notes, metadata, musicXml: correctedMusicXml };
  }

  /* ─── Internal Helpers ─── */

  static _extractMeasures(partXml) {
    const measures = [];
    const regex = /<measure[^>]*>([\s\S]*?)<\/measure>/g;
    let match;
    while ((match = regex.exec(partXml)) !== null) {
      measures.push(match[0]);
    }
    return measures;
  }

  static _pitchToMidi(step, octave, alter) {
    return 12 * (octave + 1) + (PITCH_SEMITONES[step] || 0) + alter;
  }

  static _beatsToType(beats) {
    if (beats >= 4) return 'whole';
    if (beats >= 2) return 'half';
    if (beats >= 1) return 'quarter';
    if (beats >= 0.5) return 'eighth';
    if (beats >= 0.25) return 'sixteenth';
    return '32nd';
  }

  static _fifthsToKey(fifths) {
    if (fifths === 0) return { type: 'None', count: 0, fifths: 0 };
    if (fifths > 0) return { type: 'Sharps', count: fifths, fifths };
    return { type: 'Flats', count: Math.abs(fifths), fifths };
  }

  /**
   * Resolve ties by merging consecutive tied notes of the same pitch.
   */
  static _resolveTies(notes) {
    const openTies = new Map();
    const TIE_CONTIGUITY_EPSILON_MIN = 0.02;
    const TIE_CONTIGUITY_EPSILON_MAX = 0.12;

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      if (note.type !== 'note') continue;

      const key = `${note.partIndex}_${note.staffIndex}_${note.voice}_${note.midiNote}`;

      if (note._tieStop && openTies.has(key)) {
        const startIdx = openTies.get(key);
        const starter = notes[startIdx];
        const startBeats = starter.tiedBeats || starter.durationBeats || DURATION_BEATS[starter.duration] || 1;
        const addBeats = note.durationBeats || DURATION_BEATS[note.duration] || 1;

        // Only merge ties when the continuation is contiguous in time.
        // This prevents accidental note drops from malformed tie tags.
        const expectedStart = (starter.beatOffset || 0) + startBeats;
        const actualStart = note.beatOffset || 0;
        const tieEpsilon = Math.max(
          TIE_CONTIGUITY_EPSILON_MIN,
          Math.min(TIE_CONTIGUITY_EPSILON_MAX, Math.min(startBeats, addBeats) * 0.35)
        );
        const isContiguous = Math.abs(actualStart - expectedStart) <= tieEpsilon;

        if (isContiguous) {
          starter.tiedBeats = startBeats + addBeats;
          note._remove = true;
        } else {
          openTies.delete(key);
        }

        if (note._tieStart) {
          openTies.set(key, startIdx);
        } else {
          openTies.delete(key);
        }
      }

      if (note._tieStart && !note._remove) {
        openTies.set(key, i);
      }
    }

    for (let i = notes.length - 1; i >= 0; i--) {
      if (notes[i]._remove) {
        notes.splice(i, 1);
      } else {
        delete notes[i]._tieStart;
        delete notes[i]._tieStop;
        delete notes[i]._remove;
      }
    }
  }
}
