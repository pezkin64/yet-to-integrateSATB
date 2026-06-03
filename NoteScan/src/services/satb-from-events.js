// SATB separation from prepared note events (no DOM)
// Input: noteEvents array from AudioPlaybackService.prepareNoteEvents()
// Output: { xml: string, report: { measuresProcessed, noteCounts, restCounts } }

function midiToPitch(midi) {
  const STEP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const pc = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  const name = STEP[pc];
  if (name.length === 1) return { step: name, alter: 0, octave };
  return { step: name[0], alter: 1, octave };
}

function durationTypeStrSimple(durBeats, divisions) {
  // reuse simple mapping quarter=1
  const ratio = durBeats / (divisions / 2); // if divisions==2, ratio=durBeats
  if (ratio <= 0.25) return 'sixteenth';
  if (ratio <= 0.5) return 'eighth';
  if (ratio <= 1.0) return 'quarter';
  if (ratio <= 1.5) return 'quarter';
  if (ratio <= 2.0) return 'half';
  return 'whole';
}

function noteXmlFromMidi(midi, durationTicks, typeStr, voiceNum) {
  const p = midiToPitch(midi);
  const alterTag = p.alter ? `<alter>${p.alter}</alter>` : '';
  return `<note><pitch><step>${p.step}</step>${alterTag}<octave>${p.octave}</octave></pitch><duration>${durationTicks}</duration><voice>${voiceNum}</voice><type>${typeStr}</type></note>`;
}

function restXml(durationTicks, typeStr, voiceNum) {
  return `<note><rest/><duration>${durationTicks}</duration><voice>${voiceNum}</voice><type>${typeStr}</type></note>`;
}

export function separateSATBFromEvents(noteEvents, timingBeatData = [], options = {}) {
  // Normalize divisions to 2 throughout as app expects
  const divisions = 2;

  if (!Array.isArray(noteEvents) || noteEvents.length === 0) {
    return { xml: '', report: { measuresProcessed: 0, noteCounts: {}, restCounts: {} } };
  }

  // Group by measureNum and beatOffset
  const measuresMap = new Map();
  let maxMeasure = 0;
  for (const e of noteEvents) {
    const mnum = Number.isFinite(e.measureNum) && e.measureNum > 0 ? e.measureNum : 1;
    maxMeasure = Math.max(maxMeasure, mnum);
    if (!measuresMap.has(mnum)) measuresMap.set(mnum, new Map());
    const beat = Number.isFinite(e.beatOffset) ? e.beatOffset : 0;
    const beatMap = measuresMap.get(mnum);
    if (!beatMap.has(beat)) beatMap.set(beat, []);
    beatMap.get(beat).push(e);
  }

  // Helper: assign upper/lower on a staff using voice hint then geometry/midi
  function assignUpperLower(events) {
    if (!events || events.length === 0) return { upper: null, lower: null };
    // prefer explicit voice numbers '1' or '2'
    const byVoice1 = events.filter(ev => String(ev.voice) === '1');
    const byVoice2 = events.filter(ev => String(ev.voice) === '2');
    if (byVoice1.length && byVoice2.length) {
      // choose top of voice1 -> upper, top of voice2 -> lower
      const u = byVoice1.sort((a,b)=> (b.midiNote||0)-(a.midiNote||0))[0];
      const l = byVoice2.sort((a,b)=> (a.midiNote||0)-(b.midiNote||0))[0];
      return { upper: u || null, lower: l || null };
    }
    // if single voice with chord: prefer geometry (y) when available, fallback to pitch
    const playable = events.filter(ev => Number.isFinite(ev.midiNote));
    if (playable.length === 1) return { upper: playable[0], lower: null };
    if (playable.length > 1) {
      // If y positions are present, smaller y == visually higher on page
      const haveY = playable.some(ev => Number.isFinite(ev.y) && ev.y !== 0);
      let sorted;
      if (haveY) {
        sorted = playable.sort((a,b) => (a.y || 0) - (b.y || 0)); // top -> first
      } else {
        sorted = playable.sort((a,b)=> (b.midiNote||0)-(a.midiNote||0)); // highest pitch first
      }
      const upper = sorted[0] || null;
      const lower = sorted.length > 1 ? sorted[sorted.length - 1] : null;
      return { upper, lower };
    }
    return { upper: null, lower: null };
  }

  // Build parts by measure
  const parts = { S: [], A: [], T: [], B: [] };
  const noteCounts = { Soprano:0, Alto:0, Tenor:0, Bass:0 };
  const restCounts = { Soprano:0, Alto:0, Tenor:0, Bass:0 };

  for (let m = 1; m <= maxMeasure; m++) {
    const beatMap = measuresMap.get(m) || new Map();
    const beatOffsets = [...beatMap.keys()].sort((a,b)=>a-b);
    // If empty measure, insert a whole rest in all parts
    if (beatOffsets.length === 0) {
      parts.S.push([ restXml(divisions*4, 'whole', 1) ]);
      parts.A.push([ restXml(divisions*4, 'whole', 1) ]);
      parts.T.push([ restXml(divisions*4, 'whole', 1) ]);
      parts.B.push([ restXml(divisions*4, 'whole', 1) ]);
      restCounts.Soprano++; restCounts.Alto++; restCounts.Tenor++; restCounts.Bass++;
      continue;
    }

    const soprNotes = [];
    const altoNotes = [];
    const tenorNotes = [];
    const bassNotes = [];

    for (const bo of beatOffsets) {
      const evs = beatMap.get(bo) || [];
      // split by staffIndex: assume smaller staffIndex = treble
      const staffs = new Map();
      for (const ev of evs) {
        const sidx = Number.isFinite(ev.staffIndex) ? ev.staffIndex : 0;
        if (!staffs.has(sidx)) staffs.set(sidx, []);
        staffs.get(sidx).push(ev);
      }
      const staffKeys = [...staffs.keys()].sort((a,b)=>a-b);
      const trebleEvents = staffs.get(staffKeys[0]) || [];
      const bassEvents = staffs.get(staffKeys[1]) || [];

      const treAssigned = assignUpperLower(trebleEvents);
      const bassAssigned = assignUpperLower(bassEvents);

      // durations in ticks (divisions=2 means quarter=2 ticks)
      const durationBeats = evs[0]?.durationBeats || 1;
      const durationTicks = Math.max(1, Math.round(durationBeats * divisions));
      const typeStr = durationTypeStrSimple(durationBeats, divisions);

      if (treAssigned.upper) {
        soprNotes.push(noteXmlFromMidi(treAssigned.upper.midiNote, durationTicks, typeStr, 1));
        noteCounts.Soprano++;
      } else {
        soprNotes.push(restXml(durationTicks, typeStr, 1)); restCounts.Soprano++;
      }
      if (treAssigned.lower) {
        altoNotes.push(noteXmlFromMidi(treAssigned.lower.midiNote, durationTicks, typeStr, 1));
        noteCounts.Alto++;
      } else {
        altoNotes.push(restXml(durationTicks, typeStr, 1)); restCounts.Alto++;
      }

      if (bassAssigned.upper) {
        tenorNotes.push(noteXmlFromMidi(bassAssigned.upper.midiNote, durationTicks, typeStr, 1));
        noteCounts.Tenor++;
      } else {
        tenorNotes.push(restXml(durationTicks, typeStr, 1)); restCounts.Tenor++;
      }
      if (bassAssigned.lower) {
        bassNotes.push(noteXmlFromMidi(bassAssigned.lower.midiNote, durationTicks, typeStr, 1));
        noteCounts.Bass++;
      } else {
        bassNotes.push(restXml(durationTicks, typeStr, 1)); restCounts.Bass++;
      }
    }

    parts.S.push(soprNotes);
    parts.A.push(altoNotes);
    parts.T.push(tenorNotes);
    parts.B.push(bassNotes);
  }

  // Build MusicXML
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="3.0">');
  lines.push('  <part-list>');
  ['Soprano','Alto','Tenor','Bass'].forEach((v,i)=>{
    const id = v[0];
    lines.push(`    <score-part id="${id}">`);
    lines.push(`      <part-name>${v}</part-name>`);
    lines.push(`      <score-instrument id="${id}-I1"><instrument-name>${v}</instrument-name></score-instrument>`);
    lines.push(`      <midi-instrument id="${id}-I1"><midi-channel>${i+1}</midi-channel><midi-program>52</midi-program></midi-instrument>`);
    lines.push('    </score-part>');
  });
  lines.push('  </part-list>');

  // Parts contents
  const clefs = {
    Soprano: '<clef><sign>G</sign><line>2</line></clef>',
    Alto: '<clef><sign>G</sign><line>2</line></clef>',
    Tenor: '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>',
    Bass: '<clef><sign>F</sign><line>4</line></clef>'
  };

  const voiceParts = { Soprano: parts.S, Alto: parts.A, Tenor: parts.T, Bass: parts.B };
  for (const v of ['Soprano','Alto','Tenor','Bass']) {
    const pid = v[0];
    lines.push(`  <part id="${pid}">`);
    const measures = voiceParts[v];
    for (let mi = 0; mi < measures.length; mi++) {
      lines.push(`    <measure number="${mi+1}">`);
      if (mi === 0) {
        lines.push('      <attributes>');
        lines.push(`        <divisions>${divisions}</divisions>`);
        lines.push('        <key><fifths>0</fifths></key>');
        lines.push('        <time><beats>4</beats><beat-type>4</beat-type></time>');
        lines.push(`        ${clefs[v]}`);
        lines.push('      </attributes>');
      }
      // notes for this measure
      const noteList = measures[mi] || [];
      for (const nx of noteList) {
        lines.push(`      ${nx}`);
      }
      lines.push('    </measure>');
    }
    lines.push('  </part>');
  }
  lines.push('</score-partwise>');

  const xml = lines.join('\n');
  // Measure length validation
  const measureMismatches = [];
  for (let m = 1; m <= maxMeasure; m++) {
    const beatMap = measuresMap.get(m) || new Map();
    // Sum durationBeats of all events in this measure
    let actualBeats = 0;
    for (const events of beatMap.values()) {
      for (const ev of events) {
        actualBeats += Number.isFinite(ev.durationBeats) ? ev.durationBeats : 0;
      }
    }
    // Determine expected beats from timingBeatData if available
    const timingEntry = (Array.isArray(timingBeatData) && timingBeatData.find(t => Number.isFinite(t.measureNum) && t.measureNum === m));
    const expectedBeats = timingEntry && Number.isFinite(timingEntry.measureEndBeat) && Number.isFinite(timingEntry.measureStartBeat)
      ? (timingEntry.measureEndBeat - timingEntry.measureStartBeat)
      : 4; // default to common time
    const diff = Math.abs(actualBeats - expectedBeats);
    if (diff > 1e-6) {
      measureMismatches.push({ measure: m, expectedBeats, actualBeats });
    }
  }

  const report = { measuresProcessed: maxMeasure, noteCounts, restCounts, measureMismatches };
  return { xml, report };
}

export default { separateSATBFromEvents };
