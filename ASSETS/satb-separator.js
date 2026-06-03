"use strict";
/**
 * satb-separator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * 3-Layer SATB voice separation for MusicXML files.
 * Zero dependencies — works in React Native, Node, or browser.
 *
 * Usage:
 *   import { separateSATB } from './satb-separator';
 *   const outputXml = separateSATB(inputXmlString);
 *
 * Layer 1: Structural signals  — voice tags, stem direction, staff position
 * Layer 2: DP voice assignment — voice-leading cost minimization
 * Layer 3: Harmonic validation — diatonic plausibility check against key
 * ─────────────────────────────────────────────────────────────────────────────
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.separateSATB = separateSATB;
// ─── Constants ───────────────────────────────────────────────────────────────
// SATB vocal ranges — concert MIDI pitch
const RANGES = {
    Soprano: [60, 81], // C4–A5
    Alto: [53, 74], // F3–D5
    Tenor: [48, 69], // C3–A4
    Bass: [40, 62], // E2–D4
};
// Voice-leading cost weights
const W = {
    RANGE_VIOLATION: 1000,
    LEAP: 2, // per semitone above a step (>2 semitones)
    PARALLEL_5TH: 50,
    PARALLEL_8TH: 50,
    CROSSING: 30, // voice crossing
    HARMONY: 20, // note outside diatonic key
};
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const STEP_TO_SEMITONE = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11
};
// Duration ratio → note type string (relative to quarter = 1.0)
const DURATION_TYPE_MAP = [
    [0.25, 'sixteenth'],
    [0.5, 'eighth'],
    [1.0, 'quarter'],
    [1.5, 'quarter'], // dotted quarter — simplified
    [2.0, 'half'],
    [3.0, 'half'], // dotted half — simplified
    [4.0, 'whole'],
];
// ─── Pitch utilities ─────────────────────────────────────────────────────────
function midiFromParts(step, octave, alter, transposeChromatic) {
    const base = (parseInt(octave) + 1) * 12 + STEP_TO_SEMITONE[step] + parseFloat(alter || '0');
    return base + transposeChromatic;
}
function midiName(midi) {
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
function intervalSemitones(a, b) {
    return Math.abs(a - b);
}
function diatonicPCs(fifths) {
    // Major scale pitch classes, shifted by key
    const majorPCs = [0, 2, 4, 5, 7, 9, 11]; // C major
    const shiftMap = {
        0: 0, 1: 7, 2: 2, 3: 9, 4: 4, 5: 11, 6: 6,
        '-1': 5, '-2': 10, '-3': 3, '-4': 8, '-5': 1, '-6': 6
    };
    const shift = shiftMap[fifths] ?? 0;
    return new Set(majorPCs.map(pc => (pc + shift) % 12));
}
function durationTypeStr(dur, divisions) {
    const ratio = dur / divisions; // ratio relative to quarter note
    let best = 'quarter';
    let bestDiff = Infinity;
    for (const [r, t] of DURATION_TYPE_MAP) {
        const diff = Math.abs(r - ratio);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = t;
        }
    }
    return best;
}
// ─── XML utilities (no DOM dependency — pure string parsing) ─────────────────
/**
 * Minimal XML parser — extracts just what we need from MusicXML.
 * Uses regex-based extraction for React Native compatibility
 * (no DOMParser available in RN without a polyfill).
 */
class XmlNode {
    constructor(tag, attrs, text, children, raw) {
        this.tag = tag;
        this.attributes = attrs;
        this.text = text;
        this.children = children;
        this.raw = raw;
    }
    findAll(tagName) {
        const results = [];
        for (const child of this.children) {
            if (child.tag === tagName)
                results.push(child);
            results.push(...child.findAll(tagName));
        }
        return results;
    }
    find(tagName) {
        for (const child of this.children) {
            if (child.tag === tagName)
                return child;
            const found = child.find(tagName);
            if (found)
                return found;
        }
        return null;
    }
    findDirect(tagName) {
        return this.children.find(c => c.tag === tagName) ?? null;
    }
    findDirectAll(tagName) {
        return this.children.filter(c => c.tag === tagName);
    }
    getText(tagName, defaultVal = '') {
        const node = this.find(tagName);
        return node?.text ?? defaultVal;
    }
    getDirectText(tagName, defaultVal = '') {
        const node = this.findDirect(tagName);
        return node?.text ?? defaultVal;
    }
}
function parseXml(xml) {
    // Strip XML declaration and DOCTYPE
    const cleaned = xml
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!DOCTYPE[^>]*>/g, '')
        .trim();
    const [node] = parseElement(cleaned, 0);
    return node;
}
function parseElement(xml, start) {
    // Skip whitespace
    let i = start;
    while (i < xml.length && /\s/.test(xml[i]))
        i++;
    if (xml[i] !== '<')
        throw new Error(`Expected '<' at position ${i}`);
    // Read opening tag
    let j = i + 1;
    while (j < xml.length && xml[j] !== '>' && xml[j] !== ' ' && xml[j] !== '\n' && xml[j] !== '\r' && xml[j] !== '\t' && xml[j] !== '/')
        j++;
    const tagName = xml.slice(i + 1, j).trim();
    // Read attributes
    const attrs = {};
    let k = j;
    while (k < xml.length && xml[k] !== '>' && !(xml[k] === '/' && xml[k + 1] === '>')) {
        while (k < xml.length && /[\s]/.test(xml[k]))
            k++;
        if (xml[k] === '>' || (xml[k] === '/' && xml[k + 1] === '>'))
            break;
        // Read attr name
        let an = k;
        while (k < xml.length && xml[k] !== '=' && xml[k] !== '>' && !/\s/.test(xml[k]))
            k++;
        const attrName = xml.slice(an, k).trim();
        if (!attrName) {
            k++;
            continue;
        }
        while (k < xml.length && /\s/.test(xml[k]))
            k++;
        if (xml[k] === '=') {
            k++;
            while (k < xml.length && /\s/.test(xml[k]))
                k++;
            const quote = xml[k];
            if (quote === '"' || quote === "'") {
                k++;
                let av = k;
                while (k < xml.length && xml[k] !== quote)
                    k++;
                attrs[attrName] = xml.slice(av, k);
                k++; // skip closing quote
            }
        }
    }
    // Self-closing tag
    if (xml[k] === '/' && xml[k + 1] === '>') {
        const raw = xml.slice(i, k + 2);
        return [new XmlNode(tagName, attrs, '', [], raw), k + 2];
    }
    k++; // skip '>'
    // Read children and text
    const children = [];
    let text = '';
    let contentStart = k;
    while (k < xml.length) {
        // Closing tag
        if (xml[k] === '<' && xml[k + 1] === '/') {
            let end = k + 2;
            while (end < xml.length && xml[end] !== '>')
                end++;
            k = end + 1;
            break;
        }
        // Child element
        if (xml[k] === '<' && xml[k + 1] !== '!' && xml[k + 1] !== '?') {
            const [child, next] = parseElement(xml, k);
            children.push(child);
            k = next;
        }
        else if (xml[k] === '<') {
            // Comment or PI — skip
            let end = k;
            while (end < xml.length && xml[end] !== '>')
                end++;
            k = end + 1;
        }
        else {
            // Text content
            let t = k;
            while (k < xml.length && xml[k] !== '<')
                k++;
            text += xml.slice(t, k);
        }
    }
    const raw = xml.slice(start, k);
    return [new XmlNode(tagName, attrs, text.trim(), children, raw), k];
}
// ─── XML serialization helpers ───────────────────────────────────────────────
function xmlEl(tag, attrs = {}, children = [], text = '') {
    const attrStr = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    const inner = text || children.join('\n');
    if (!inner)
        return `<${tag}${attrStr}/>`;
    return `<${tag}${attrStr}>${inner}</${tag}>`;
}
function cloneNoteXml(rawXml, voiceNum, duration, noteTypeStr) {
    // Remove <chord/>, <staff>, <beam> tags; update <voice> and <duration>
    let xml = rawXml;
    xml = xml.replace(/<chord\s*\/>/g, '');
    xml = xml.replace(/<chord><\/chord>/g, '');
    xml = xml.replace(/<staff>[^<]*<\/staff>/g, '');
    xml = xml.replace(/<beam[^>]*>[^<]*<\/beam>/g, '');
    xml = xml.replace(/<voice>[^<]*<\/voice>/g, `<voice>${voiceNum}</voice>`);
    xml = xml.replace(/<duration>[^<]*<\/duration>/g, `<duration>${duration}</duration>`);
    xml = xml.replace(/<type>[^<]*<\/type>/g, `<type>${noteTypeStr}</type>`);
    return xml;
}
function makeRestXml(duration, noteTypeStr, voiceNum) {
    return `<note><rest/><duration>${duration}</duration><voice>${voiceNum}</voice><type>${noteTypeStr}</type></note>`;
}
// ─── Stage 1: Pre-process ────────────────────────────────────────────────────
function preprocessXml(xml) {
    // Fix absurdly low tempo values
    let out = xml.replace(/(<per-minute>)(\d+)(<\/per-minute>)/g, (_, open, val, close) => {
        return parseFloat(val) < 20 ? `${open}80${close}` : `${open}${val}${close}`;
    });
    out = out.replace(/(tempo=")(\d+(?:\.\d+)??)(")/g, (_, open, val, close) => {
        return parseFloat(val) < 20 ? `${open}80${close}` : `${open}${val}${close}`;
    });
    return out;
}
// ─── Stage 2: Extract beat events ────────────────────────────────────────────
function extractBeatEvents(partNode, transposeChromatic) {
    const measures = [];
    let currentDivisions = 1;
    for (const measureNode of partNode.findDirectAll('measure')) {
        const mnum = measureNode.attributes['number'] ?? '?';
        const attrsNode = measureNode.findDirect('attributes');
        if (attrsNode) {
            const divText = attrsNode.getDirectText('divisions');
            if (divText)
                currentDivisions = parseInt(divText);
        }
        const beatMap = new Map();
        let offset = 0;
        for (const child of measureNode.children) {
            if (child.tag === 'note') {
                const isChord = child.findDirect('chord') !== null;
                const isRest = child.findDirect('rest') !== null;
                let midi = null;
                if (!isRest) {
                    const pitchNode = child.findDirect('pitch');
                    if (pitchNode) {
                        const step = pitchNode.getDirectText('step', 'C');
                        const octave = pitchNode.getDirectText('octave', '4');
                        const alter = pitchNode.getDirectText('alter', '0');
                        midi = midiFromParts(step, octave, alter, transposeChromatic);
                    }
                }
                const note = {
                    midi,
                    voice: child.getDirectText('voice', '1'),
                    stem: child.getDirectText('stem', ''),
                    duration: parseInt(child.getDirectText('duration', '0')),
                    noteType: child.getDirectText('type', 'quarter'),
                    isChord,
                    isRest,
                    rawXml: child.raw,
                };
                if (!beatMap.has(offset))
                    beatMap.set(offset, []);
                beatMap.get(offset).push(note);
                if (!isChord)
                    offset += note.duration;
            }
            else if (child.tag === 'backup') {
                offset -= parseInt(child.getDirectText('duration', '0'));
                if (offset < 0)
                    offset = 0;
            }
            else if (child.tag === 'forward') {
                offset += parseInt(child.getDirectText('duration', '0'));
            }
        }
        const beats = [];
        for (const [off, notes] of [...beatMap.entries()].sort(([a], [b]) => a - b)) {
            const dur = Math.max(...notes.map(n => n.duration), 1);
            beats.push({ offset: off, duration: dur, notes });
        }
        measures.push({ number: mnum, divisions: currentDivisions, beats });
    }
    return measures;
}
// ─── Stage 3: DP voice assignment ────────────────────────────────────────────
function voiceLeadCost(prev, curr, keyPCs) {
    let cost = 0;
    const rangeNames = ['Soprano', 'Alto', 'Tenor', 'Bass'];
    // Range violations
    for (let i = 0; i < 4; i++) {
        const m = curr[i];
        if (m === null)
            continue;
        const [lo, hi] = RANGES[rangeNames[i]];
        if (m < lo || m > hi) {
            cost += W.RANGE_VIOLATION * (1 + Math.min(Math.abs(m - lo), Math.abs(m - hi)));
        }
    }
    // Voice leading from previous chord
    if (prev.some(p => p !== null)) {
        for (let i = 0; i < 4; i++) {
            const pm = prev[i], cm = curr[i];
            if (pm === null || cm === null)
                continue;
            const leap = Math.max(0, intervalSemitones(pm, cm) - 2);
            cost += W.LEAP * leap;
        }
        // Parallel 5ths and octaves
        for (let i = 0; i < 4; i++) {
            for (let j = i + 1; j < 4; j++) {
                const pmi = prev[i], pmj = prev[j], cmi = curr[i], cmj = curr[j];
                if (pmi === null || pmj === null || cmi === null || cmj === null)
                    continue;
                const prevInt = intervalSemitones(pmi, pmj) % 12;
                const currInt = intervalSemitones(cmi, cmj) % 12;
                if (prevInt === 7 && currInt === 7)
                    cost += W.PARALLEL_5TH;
                if (prevInt === 0 && currInt === 0)
                    cost += W.PARALLEL_8TH;
            }
        }
    }
    // Voice order: S ≥ A ≥ T ≥ B
    const [s, a, t, b] = curr;
    if (s !== null && a !== null && s < a)
        cost += W.CROSSING;
    if (a !== null && t !== null && a < t)
        cost += W.CROSSING;
    if (t !== null && b !== null && t < b)
        cost += W.CROSSING;
    // Harmonic plausibility
    for (const m of curr) {
        if (m !== null && !keyPCs.has(m % 12))
            cost += W.HARMONY;
    }
    return cost;
}
function assignSATB(trebleMeasures, bassMeasures, keyFifths, transposeChromatic) {
    const keyPCs = diatonicPCs(keyFifths);
    const results = [];
    let prevMidis = [null, null, null, null];
    for (let mi = 0; mi < trebleMeasures.length; mi++) {
        const tMeas = trebleMeasures[mi];
        const bMeas = bassMeasures[mi];
        const divisions = tMeas.divisions;
        // Unified offset timeline
        const allOffsets = [...new Set([
                ...tMeas.beats.map(b => b.offset),
                ...bMeas.beats.map(b => b.offset),
            ])].sort((a, b) => a - b);
        const notesAt = (beats, off) => {
            const b = beats.find(b => b.offset === off);
            return b ? [b.notes, b.duration] : [[], 0];
        };
        const topMidi = (notes) => {
            const ms = notes.map(n => n.midi).filter((m) => m !== null);
            return ms.length ? Math.max(...ms) : null;
        };
        const botMidi = (notes) => {
            const ms = notes.map(n => n.midi).filter((m) => m !== null);
            return ms.length ? Math.min(...ms) : null;
        };
        const topXml = (notes) => {
            const cands = notes.filter(n => n.midi !== null);
            if (!cands.length)
                return notes[0]?.rawXml ?? null;
            return cands.reduce((a, b) => (a.midi > b.midi ? a : b)).rawXml;
        };
        const botXml = (notes) => {
            const cands = notes.filter(n => n.midi !== null);
            if (!cands.length)
                return notes[0]?.rawXml ?? null;
            return cands.reduce((a, b) => (a.midi < b.midi ? a : b)).rawXml;
        };
        const beatResults = [];
        for (const off of allOffsets) {
            const [tNotes, tDur] = notesAt(tMeas.beats, off);
            const [bNotes, bDur] = notesAt(bMeas.beats, off);
            const dur = Math.max(tDur, bDur, 1);
            // ── Layer 1: structural voice tag split ──────────────────────────
            const tv1 = tNotes.filter(n => n.voice === '1');
            const tv2 = tNotes.filter(n => n.voice === '2');
            const bv1 = bNotes.filter(n => n.voice === '1');
            const bv2 = bNotes.filter(n => n.voice === '2');
            // Initial structural assignment
            const hasMultipleT = tv1.filter(n => n.midi !== null).length > 1;
            const hasMultipleB = bv1.filter(n => n.midi !== null).length > 1;
            let candS = topMidi(tv1);
            let candA = hasMultipleT ? botMidi(tv1) : (tv2.length ? topMidi(tv2) : null);
            let candT = topMidi(bv1);
            let candB = hasMultipleB ? botMidi(bv1) : (bv2.length ? topMidi(bv2) : null);
            // Source XML elements
            let sXml = topXml(tv1);
            let aXml = tv2.length ? topXml(tv2) : botXml(tv1);
            let tXml = topXml(bv1);
            let bXml = bv2.length ? topXml(bv2) : botXml(bv1);
            // ── Layer 2: DP cost check ────────────────────────────────────────
            const curr = [candS, candA, candT, candB];
            // Try swapping S/A (treble voice crossing is the most common ambiguity)
            const alts = [curr];
            if (candS !== null && candA !== null) {
                alts.push([candA, candS, candT, candB]);
            }
            // Try swapping T/B
            if (candT !== null && candB !== null) {
                alts.push([candS, candA, candB, candT]);
            }
            let best = curr;
            let bestCost = voiceLeadCost(prevMidis, curr, keyPCs);
            for (const alt of alts.slice(1)) {
                const c = voiceLeadCost(prevMidis, alt, keyPCs);
                if (c < bestCost) {
                    best = alt;
                    bestCost = c;
                }
            }
            prevMidis = best;
            beatResults.push({
                offset: off,
                duration: dur,
                S: best[0], A: best[1], T: best[2], B: best[3],
                S_xml: sXml, A_xml: aXml, T_xml: tXml, B_xml: bXml,
            });
        }
        results.push({ number: tMeas.number, beats: beatResults });
    }
    return results;
}
// ─── Stage 4: Build output MusicXML string ───────────────────────────────────
const CLEF_DEFS = {
    Soprano: { sign: 'G', line: '2' },
    Alto: { sign: 'G', line: '2' },
    Tenor: { sign: 'G', line: '2', octaveChange: '-1' },
    Bass: { sign: 'F', line: '4' },
};
const MIDI_CHANNELS = {
    Soprano: '1', Alto: '2', Tenor: '3', Bass: '4'
};
const MIDI_PROGRAMS = {
    Soprano: '52', Alto: '52', Tenor: '53', Bass: '53'
};
function buildOutputXml(assignments, keyFifths, timeBeats, timeBeatType) {
    const voices = ['Soprano', 'Alto', 'Tenor', 'Bass'];
    const vkeys = ['S', 'A', 'T', 'B'];
    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
    lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
    lines.push('<score-partwise version="3.0">');
    lines.push('  <work><work-title>Scanned Score — SATB Separated</work-title></work>');
    lines.push('  <identification><encoding><software>satb-separator.ts</software></encoding></identification>');
    // Part list
    lines.push('  <part-list>');
    for (const v of voices) {
        const id = v[0];
        lines.push(`    <score-part id="${id}">`);
        lines.push(`      <part-name>${v}</part-name>`);
        lines.push(`      <score-instrument id="${id}-I1"><instrument-name>${v}</instrument-name></score-instrument>`);
        lines.push(`      <midi-instrument id="${id}-I1">`);
        lines.push(`        <midi-channel>${MIDI_CHANNELS[v]}</midi-channel>`);
        lines.push(`        <midi-program>${MIDI_PROGRAMS[v]}</midi-program>`);
        lines.push(`      </midi-instrument>`);
        lines.push(`    </score-part>`);
    }
    lines.push('  </part-list>');
    // Parts
    for (let vi = 0; vi < voices.length; vi++) {
        const vname = voices[vi];
        const vkey = vkeys[vi];
        const partId = vname[0];
        const clef = CLEF_DEFS[vname];
        lines.push(`  <part id="${partId}">`);
        for (let mi = 0; mi < assignments.length; mi++) {
            const mdata = assignments[mi];
            lines.push(`    <measure number="${mdata.number}">`);
            // Attributes in measure 1
            if (mi === 0) {
                lines.push('      <attributes>');
                lines.push('        <divisions>2</divisions>');
                lines.push(`        <key><fifths>${keyFifths}</fifths></key>`);
                lines.push(`        <time><beats>${timeBeats}</beats><beat-type>${timeBeatType}</beat-type></time>`);
                lines.push(`        <clef><sign>${clef.sign}</sign><line>${clef.line}</line>${clef.octaveChange ? `<clef-octave-change>${clef.octaveChange}</clef-octave-change>` : ''}</clef>`);
                lines.push('      </attributes>');
                // Tempo on soprano only
                if (vname === 'Soprano') {
                    lines.push('      <direction placement="above">');
                    lines.push('        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>80</per-minute></metronome></direction-type>');
                    lines.push('        <sound tempo="80"/>');
                    lines.push('      </direction>');
                }
            }
            // Notes
            let prevOffset = 0;
            for (const beat of mdata.beats) {
                // Fill gap with rest if needed
                const gap = beat.offset - prevOffset;
                if (gap > 0) {
                    lines.push('      ' + makeRestXml(gap, durationTypeStr(gap, 2), 1));
                }
                const midi = beat[vkey];
                const srcXml = beat[`${vkey}_xml`];
                const noteTypeStr = durationTypeStr(beat.duration, 2);
                if (midi === null || srcXml === null) {
                    lines.push('      ' + makeRestXml(beat.duration, noteTypeStr, 1));
                }
                else {
                    lines.push('      ' + cloneNoteXml(srcXml, 1, beat.duration, noteTypeStr));
                }
                prevOffset = beat.offset + beat.duration;
            }
            lines.push('    </measure>');
        }
        lines.push('  </part>');
    }
    lines.push('</score-partwise>');
    return lines.join('\n');
}
// ─── Stage 5: Validation report ──────────────────────────────────────────────
function validateAssignments(assignments, keyFifths, transposeChromatic) {
    const voiceRanges = {
        S: { min: 999, max: 0, minName: '', maxName: '' },
        A: { min: 999, max: 0, minName: '', maxName: '' },
        T: { min: 999, max: 0, minName: '', maxName: '' },
        B: { min: 999, max: 0, minName: '', maxName: '' },
    };
    const issues = [];
    const vkeys = ['S', 'A', 'T', 'B'];
    const vnames = ['Soprano', 'Alto', 'Tenor', 'Bass'];
    let beatCount = 0;
    for (const mdata of assignments) {
        for (const beat of mdata.beats) {
            beatCount++;
            const midis = vkeys.map(k => beat[k]);
            for (let i = 0; i < 4; i++) {
                const m = midis[i];
                if (m === null)
                    continue;
                const r = voiceRanges[vkeys[i]];
                if (m < r.min) {
                    r.min = m;
                    r.minName = midiName(m);
                }
                if (m > r.max) {
                    r.max = m;
                    r.maxName = midiName(m);
                }
                const [lo, hi] = RANGES[vnames[i]];
                if (m < lo || m > hi) {
                    issues.push(`M${mdata.number} offset ${beat.offset}: ${vnames[i]} MIDI ${m} (${midiName(m)}) outside range`);
                }
            }
            const [s, a, t, b] = midis;
            if (s !== null && a !== null && s < a)
                issues.push(`M${mdata.number}: soprano below alto`);
            if (a !== null && t !== null && a < t)
                issues.push(`M${mdata.number}: alto below tenor`);
            if (t !== null && b !== null && t < b)
                issues.push(`M${mdata.number}: tenor below bass`);
        }
    }
    return {
        measuresProcessed: assignments.length,
        beatEventsAssigned: beatCount,
        keyFifths,
        transposeChromatic,
        voiceRanges,
        issues,
    };
}
/**
 * Main entry point.
 *
 * @param inputXml  - Raw MusicXML string (2-part treble+bass score)
 * @param options   - Optional overrides
 * @returns         - { xml: string, report: SATBReport }
 *
 * Example (React Native):
 *   import RNFS from 'react-native-fs';
 *   import { separateSATB } from './satb-separator';
 *
 *   const xml = await RNFS.readFile(path, 'utf8');
 *   const { xml: satbXml, report } = separateSATB(xml);
 *   await RNFS.writeFile(outputPath, satbXml, 'utf8');
 *   console.log(report);
 */
function separateSATB(inputXml, options = {}) {
    // Stage 1: pre-process
    const fixTempo = options.fixTempo !== false;
    const processedXml = fixTempo ? preprocessXml(inputXml) : inputXml;
    // Parse XML
    const root = parseXml(processedXml);
    // Read key and time signature
    const parts = root.findAll('part');
    if (parts.length < 2) {
        throw new Error('Expected at least 2 parts (treble + bass). Found: ' + parts.length);
    }
    const m1attrs = parts[0].find('attributes');
    const keyFifths = parseInt(m1attrs?.getText('fifths') ?? '0');
    const timeBeats = parseInt(m1attrs?.getText('beats') ?? '2');
    const timeBeatType = parseInt(m1attrs?.getText('beat-type') ?? '4');
    // Auto-detect transpose from file, or use option override
    let transposeChromatic = options.transposeChromatic ?? 0;
    if (options.transposeChromatic === undefined) {
        const transNode = m1attrs?.find('transpose');
        const chromatic = transNode?.getText('chromatic');
        if (chromatic)
            transposeChromatic = parseInt(chromatic);
    }
    // Stage 2: extract beat events
    const trebleMeasures = extractBeatEvents(parts[0], transposeChromatic);
    const bassMeasures = extractBeatEvents(parts[1], transposeChromatic);
    if (trebleMeasures.length !== bassMeasures.length) {
        throw new Error(`Part measure count mismatch: treble=${trebleMeasures.length} bass=${bassMeasures.length}`);
    }
    // Stage 3: DP voice assignment
    const assignments = assignSATB(trebleMeasures, bassMeasures, keyFifths, transposeChromatic);
    // Stage 4: build output XML
    const outputXml = buildOutputXml(assignments, keyFifths, timeBeats, timeBeatType);
    // Stage 5: validate
    const report = validateAssignments(assignments, keyFifths, transposeChromatic);
    return { xml: outputXml, report };
}
