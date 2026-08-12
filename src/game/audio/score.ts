import {
  defineGenerationVariant,
  generationValue,
  scoreLengthTicks,
  type GenerationId,
  type GenerationVariant,
  type Note,
  type Score,
  type Track,
  type TrackRole,
} from '@console-chaos/engine';

/**
 * 曲は 1 つ。編曲だけが世代ごとに変わる（実装計画 §4.1）。
 *
 * **ここに書いてあるのは「曲」であって「4 つの曲」ではない。** 和声進行・主旋律・
 * ベース・ドラムはこのファイルの上半分に 1 度だけ書かれ、下半分の編曲テーブルは
 * 「その世代で鳴らすパートはどれか」を選ぶだけである。世代を切り替えたときに
 * 曲が途切れないのは、`MusicClock` が位相を保つからだけではなく、
 * **4 つの編曲が同じ長さの同じ進行**でできているからでもある。
 *
 * 位相保存の条件は `bpm` / `beatsPerBar` / 曲長がすべて一致していること。
 * `score-phase.spec.ts` がそれを固定する。
 */

/** テンポと分解能。4 編曲で共通（位相保存の条件） */
export const TEMPO = { bpm: 152, beatsPerBar: 4, ticksPerBeat: 24 } as const;

/** 1 小節のティック数 */
export const TICKS_PER_BAR = TEMPO.ticksPerBeat * TEMPO.beatsPerBar;
/** 音価。8 分 = 12 / 4 分 = 24 / 2 分 = 48 */
const EIGHTH = TEMPO.ticksPerBeat / 2;
const QUARTER = TEMPO.ticksPerBeat;
const HALF = TEMPO.ticksPerBeat * 2;

/** 曲の長さ（小節）。8 小節の楽節を 4 回 */
export const BARS = 32;
const PHRASE_BARS = 8;

/**
 * 和声進行（8 小節）。ベース・パッド・分散和音がこの 1 つの表から出る。
 * イ短調。最後の E（属和音）が次の Am へ返すので、32 小節が切れ目なく回る。
 */
interface Chord {
  /** ベースの根音（MIDI） */
  readonly root: number;
  /** 三和音（MIDI）。パッドと分散和音が使う */
  readonly triad: readonly [number, number, number];
}

const PROGRESSION: readonly Chord[] = [
  { root: 45, triad: [57, 60, 64] }, // Am
  { root: 41, triad: [53, 57, 60] }, // F
  { root: 48, triad: [52, 55, 60] }, // C
  { root: 43, triad: [50, 55, 59] }, // G
  { root: 45, triad: [57, 60, 64] }, // Am
  { root: 41, triad: [53, 57, 60] }, // F
  { root: 50, triad: [53, 57, 62] }, // Dm
  { root: 40, triad: [52, 56, 59] }, // E
];

/** 小節内の 1 音。`at` は小節頭からのティック */
interface Phrase {
  readonly at: number;
  readonly pitch: number;
  readonly length: number;
}

/** 主旋律 A（8 小節）。刻みが細かく、走り出しの推進力を担う */
const MELODY_A: readonly (readonly Phrase[])[] = [
  [
    { at: 0, pitch: 69, length: EIGHTH },
    { at: 12, pitch: 72, length: EIGHTH },
    { at: 24, pitch: 76, length: QUARTER },
    { at: 48, pitch: 74, length: EIGHTH },
    { at: 60, pitch: 72, length: EIGHTH },
    { at: 72, pitch: 69, length: QUARTER },
  ],
  [
    { at: 0, pitch: 65, length: QUARTER },
    { at: 24, pitch: 69, length: EIGHTH },
    { at: 36, pitch: 72, length: EIGHTH },
    { at: 48, pitch: 69, length: HALF },
  ],
  [
    { at: 0, pitch: 67, length: EIGHTH },
    { at: 12, pitch: 72, length: EIGHTH },
    { at: 24, pitch: 76, length: QUARTER },
    { at: 48, pitch: 79, length: QUARTER },
    { at: 72, pitch: 76, length: QUARTER },
  ],
  [
    { at: 0, pitch: 74, length: QUARTER },
    { at: 24, pitch: 71, length: EIGHTH },
    { at: 36, pitch: 67, length: EIGHTH },
    { at: 48, pitch: 71, length: HALF },
  ],
  [
    { at: 0, pitch: 69, length: EIGHTH },
    { at: 12, pitch: 72, length: EIGHTH },
    { at: 24, pitch: 76, length: QUARTER },
    { at: 48, pitch: 81, length: QUARTER },
    { at: 72, pitch: 79, length: QUARTER },
  ],
  [
    { at: 0, pitch: 77, length: QUARTER },
    { at: 24, pitch: 76, length: EIGHTH },
    { at: 36, pitch: 72, length: EIGHTH },
    { at: 48, pitch: 69, length: HALF },
  ],
  [
    { at: 0, pitch: 74, length: QUARTER },
    { at: 24, pitch: 77, length: EIGHTH },
    { at: 36, pitch: 74, length: EIGHTH },
    { at: 48, pitch: 69, length: HALF },
  ],
  [
    { at: 0, pitch: 76, length: QUARTER },
    { at: 24, pitch: 74, length: EIGHTH },
    { at: 36, pitch: 72, length: EIGHTH },
    { at: 48, pitch: 71, length: HALF },
  ],
];

/** 主旋律 B（8 小節）。音価を伸ばし、音域を上げて中盤の広がりを作る */
const MELODY_B: readonly (readonly Phrase[])[] = [
  [
    { at: 0, pitch: 81, length: HALF },
    { at: 48, pitch: 79, length: QUARTER },
    { at: 72, pitch: 76, length: QUARTER },
  ],
  [
    { at: 0, pitch: 77, length: HALF },
    { at: 48, pitch: 76, length: HALF },
  ],
  [
    { at: 0, pitch: 79, length: QUARTER },
    { at: 24, pitch: 76, length: QUARTER },
    { at: 48, pitch: 72, length: HALF },
  ],
  [
    { at: 0, pitch: 74, length: QUARTER },
    { at: 24, pitch: 79, length: QUARTER },
    { at: 48, pitch: 83, length: HALF },
  ],
  [
    { at: 0, pitch: 81, length: HALF },
    { at: 48, pitch: 84, length: HALF },
  ],
  [
    { at: 0, pitch: 84, length: QUARTER },
    { at: 24, pitch: 81, length: QUARTER },
    { at: 48, pitch: 77, length: HALF },
  ],
  [
    { at: 0, pitch: 74, length: EIGHTH },
    { at: 12, pitch: 77, length: EIGHTH },
    { at: 24, pitch: 81, length: QUARTER },
    { at: 48, pitch: 86, length: HALF },
  ],
  [
    { at: 0, pitch: 83, length: QUARTER },
    { at: 24, pitch: 80, length: QUARTER },
    { at: 48, pitch: 76, length: HALF },
  ],
];

/**
 * 楽節の並び。A / A' / B / A'' の 32 小節で、A' と A'' は同じ旋律を
 * 強さだけ変えて置く。**曲の構造もここ 1 か所にしかない。**
 */
const SECTIONS: readonly { readonly melody: typeof MELODY_A; readonly velocity: number }[] = [
  { melody: MELODY_A, velocity: 0.72 },
  { melody: MELODY_A, velocity: 0.86 },
  { melody: MELODY_B, velocity: 0.92 },
  { melody: MELODY_A, velocity: 1 },
];

/** イ短調（自然的短音階）の音度。ハモリはこの中から 3 度上を採る */
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

/** 音階の 3 度上。半音で足すと和声から外れるので、音度で 2 つ上げる */
function thirdAbove(pitch: number): number {
  const degree = MINOR_SCALE.indexOf(((pitch - 69) % 12 + 12) % 12);
  if (degree < 0) return pitch + 3;
  const octave = Math.floor((pitch - 69) / 12);
  const target = degree + 2;
  return 69 + octave * 12 + (MINOR_SCALE[target % 7] ?? 0) + Math.floor(target / 7) * 12;
}

function chordAt(bar: number): Chord {
  return PROGRESSION[bar % PHRASE_BARS]!;
}

/** 小節を跨いで走る関数を 1 つにまとめる。全パートがこれを通る */
function eachBar<T>(build: (bar: number, chord: Chord, section: number) => T[]): T[] {
  const out: T[] = [];
  for (let bar = 0; bar < BARS; bar++) {
    out.push(...build(bar, chordAt(bar), Math.floor(bar / PHRASE_BARS)));
  }
  return out;
}

// ── パート。どれも「和声進行 ＋ 楽節の並び」から出る ────────────────────────

/** 主旋律 */
function melodyNotes(): Note[] {
  return eachBar((bar, _chord, section) => {
    const { melody, velocity } = SECTIONS[section]!;
    return melody[bar % PHRASE_BARS]!.map((note) => ({
      tick: bar * TICKS_PER_BAR + note.at,
      durationTicks: note.length,
      pitch: note.pitch,
      velocity,
    }));
  });
}

/** ハモリ（3 度上）。第2世代から足す。主旋律と同じ形なので位相もそのまま */
function harmonyNotes(): Note[] {
  return melodyNotes().map((note) => ({
    ...note,
    pitch: thirdAbove(note.pitch),
    velocity: note.velocity * 0.55,
  }));
}

/** ベース。8 分でオクターブを往復する駆動系。速度感の土台になる */
function bassNotes(): Note[] {
  return eachBar((bar, chord) =>
    Array.from({ length: 8 }, (_unused, step) => ({
      tick: bar * TICKS_PER_BAR + step * EIGHTH,
      durationTicks: EIGHTH,
      pitch: chord.root + (step % 2 === 0 ? 0 : 12),
      velocity: step % 2 === 0 ? 0.9 : 0.62,
    })),
  );
}

/**
 * ドラム。`pitch` は音色番号として使われる（第1世代ではノイズの再生レートになる）。
 * 低いほど太い音になるので、キック → スネア → ハイハットの順に上げる。
 */
const DRUM = { kick: 36, snare: 50, hat: 74 } as const;

function drumNotes(withHat: boolean): Note[] {
  return eachBar((bar) => {
    const base = bar * TICKS_PER_BAR;
    const notes: Note[] = [
      { tick: base, durationTicks: EIGHTH, pitch: DRUM.kick, velocity: 1 },
      { tick: base + QUARTER, durationTicks: EIGHTH, pitch: DRUM.snare, velocity: 0.8 },
      { tick: base + HALF, durationTicks: EIGHTH, pitch: DRUM.kick, velocity: 0.9 },
      { tick: base + HALF + QUARTER, durationTicks: EIGHTH, pitch: DRUM.snare, velocity: 0.8 },
    ];
    if (!withHat) return notes;
    for (let step = 0; step < 8; step++) {
      notes.push({
        tick: base + step * EIGHTH,
        durationTicks: EIGHTH / 2,
        pitch: DRUM.hat,
        velocity: step % 2 === 0 ? 0.42 : 0.28,
      });
    }
    return notes;
  });
}

/**
 * パッド。三和音を 1 小節ずつ伸ばす。`voices` で構成音を減らせる。
 *
 * 第2世代を 2 声に絞ってあるのは**効果音のぶんを空けるため**。8 声のうち
 * 主旋律・ハモリ・ベース・ドラム 2 で 5 声が埋まり、三和音を置くと満席になる。
 * 実機でも BGM と効果音は同じ 8 声を取り合ったが、1 声も空いていないと
 * ブレーキ音が鳴るたびに旋律が欠ける（§4.3 と同じ理由）。
 */
function padNotes(octave: number, voices = 3): Note[] {
  return eachBar((bar, chord) =>
    chord.triad.slice(0, voices).map((pitch) => ({
      tick: bar * TICKS_PER_BAR,
      durationTicks: TICKS_PER_BAR,
      pitch: pitch + octave * 12,
      velocity: 0.34,
    })),
  );
}

/** 対旋律。和音の構成音を 8 分で駆け上がる。声数に余裕のある世代から足す */
function counterNotes(): Note[] {
  return eachBar((bar, chord) =>
    Array.from({ length: 8 }, (_unused, step) => ({
      tick: bar * TICKS_PER_BAR + step * EIGHTH,
      durationTicks: EIGHTH,
      pitch: chord.triad[step % 3]! + 12 * Math.floor(step / 3),
      velocity: 0.4,
    })),
  );
}

/** 楽節の頭に置く一撃。曲の区切りを耳で分かるようにする */
function accentNotes(): Note[] {
  const notes: Note[] = [];
  for (let bar = 0; bar < BARS; bar += PHRASE_BARS) {
    notes.push({
      tick: bar * TICKS_PER_BAR,
      durationTicks: QUARTER,
      pitch: chordAt(bar).triad[0]! + 24,
      velocity: 0.5,
    });
  }
  return notes;
}

function track(role: TrackRole, notes: Note[]): Track {
  return { role, notes };
}

// ── 編曲。**選ぶだけ**で、音の高さも長さも上で決まっている ──────────────────

/**
 * 世代ごとの編曲（実装計画 §4.1）。
 *
 * 声数（5 / 8 / 24 / 48）がそのままパートの数を決める。第1世代が 3 パートなのは、
 * 5 声のうち 2 声を効果音とエンジン音に空けておくためで、**空けないと
 * エンジン音が鳴るたびに BGM のパートが消える**（それも実機の挙動ではあるが、
 * 曲が壊滅しない範囲に収める。§4.3）。
 *
 * 役割はエンジン側で音源のチャンネルに割り当てられる（第1世代なら
 * lead → 矩形波 1・pad → 矩形波 2・bass → 三角波・perc → ノイズ・fx → PCM）。
 * つまり**同じ役割の 2 本目のトラックは第1世代では鳴らせない**。ハモリを
 * 第2世代からにしてあるのはそのため。
 */
export const ARRANGEMENTS: GenerationVariant<Score> = defineGenerationVariant({
  // 5 声 — 主旋律・ベース・ドラム（ハイハット無し）の 3 パート
  FC: {
    ...TEMPO,
    tracks: [
      track('lead', melodyNotes()),
      track('bass', bassNotes()),
      track('perc', drumNotes(false)),
    ],
  },
  // 8 声 — ハモリとパッドが乗り、ドラムにハイハットが入る
  SFC: {
    ...TEMPO,
    tracks: [
      track('lead', melodyNotes()),
      track('lead', harmonyNotes()),
      track('bass', bassNotes()),
      track('perc', drumNotes(true)),
      track('pad', padNotes(0, 2)),
    ],
  },
  // 24 声 — 対旋律と楽節頭の一撃が足される
  PS1: {
    ...TEMPO,
    tracks: [
      track('lead', melodyNotes()),
      track('lead', harmonyNotes()),
      track('bass', bassNotes()),
      track('perc', drumNotes(true)),
      track('pad', padNotes(0)),
      track('pad', counterNotes()),
      track('fx', accentNotes()),
    ],
  },
  // 48 声 — パッドをオクターブで重ねる。定位も効く世代なので厚みがそのまま出る
  PS2: {
    ...TEMPO,
    tracks: [
      track('lead', melodyNotes()),
      track('lead', harmonyNotes()),
      track('bass', bassNotes()),
      track('bass', bassNotes().map((note) => ({ ...note, pitch: note.pitch - 12, velocity: 0.5 }))),
      track('perc', drumNotes(true)),
      track('pad', padNotes(0)),
      track('pad', padNotes(1)),
      track('pad', counterNotes()),
      track('fx', accentNotes()),
    ],
  },
});

export function arrangementFor(generation: GenerationId): Score {
  return generationValue(ARRANGEMENTS, generation);
}

/** 曲の長さ（ティック）。4 編曲で一致していることが位相保存の条件 */
export const SCORE_LENGTH_TICKS = scoreLengthTicks(ARRANGEMENTS.FC);

/** 主旋律だけを取り出した最小の Score。起動時の器として使う */
export const SILENT_SCORE: Score = { ...TEMPO, tracks: [] };
