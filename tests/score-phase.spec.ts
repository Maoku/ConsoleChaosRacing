import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  createMusicClock,
  phasePreserved,
  scoreLengthTicks,
  secondsPerTick,
  type Score,
  type TrackRole,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { ARRANGEMENTS, BARS, TEMPO, TICKS_PER_BAR, arrangementFor } from '../src/game/audio/score.js';

/**
 * 「1 つの曲を 4 通りの音で鳴らす」を固定する（実装計画 §4.1 / §6.1 世代横断 2）。
 *
 * 位相が保たれる条件は `bpm` / `beatsPerBar` / 曲長が一致していること。
 * どれか 1 つでもずれると、世代を切り替えた瞬間に曲が飛ぶ。編曲を足すときに
 * 最も壊しやすい前提なので、4 × 4 の全ての切替でここを確かめる。
 */

/** 同時に鳴る音の最大数。声数の契約（§1.4）を編曲の側から検査する */
function maxSimultaneousVoices(score: Score): number {
  const events: [tick: number, delta: number][] = [];
  for (const track of score.tracks) {
    for (const note of track.notes) {
      events.push([note.tick, 1]);
      events.push([note.tick + note.durationTicks, -1]);
    }
  }
  // 同じティックでは「終わり」を先に処理する（隙間なく並ぶ音を二重に数えない）
  events.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function rolesOf(score: Score): TrackRole[] {
  return score.tracks.map((track) => track.role);
}

describe('編曲と位相', () => {
  it('4 編曲のテンポ・拍子・曲長が完全に一致する', () => {
    for (const generation of GENERATION_IDS) {
      const score = arrangementFor(generation);
      expect(score.bpm, `${generation} の bpm`).toBe(TEMPO.bpm);
      expect(score.beatsPerBar, `${generation} の拍子`).toBe(TEMPO.beatsPerBar);
      expect(score.ticksPerBeat, `${generation} の分解能`).toBe(TEMPO.ticksPerBeat);
      expect(scoreLengthTicks(score), `${generation} の曲長`).toBe(BARS * TICKS_PER_BAR);
    }
  });

  it('どの世代へ切り替えても曲の位置が保たれる', () => {
    const seconds = 12.5;
    for (const from of GENERATION_IDS) {
      for (const to of GENERATION_IDS) {
        const clock = createMusicClock(arrangementFor(from));
        clock.start(0);
        const before = clock.tickAt(seconds);
        // `useScore` が内部で呼ぶのがこれ。テンポが同じなら位相は動かない
        clock.rebind(arrangementFor(to));
        const after = clock.tickAt(seconds);
        expect(
          phasePreserved(before, after),
          `${from} → ${to} で位相が飛んだ（${before} → ${after}）`,
        ).toBe(true);
      }
    }
  });

  it('切り替えても小節の位置が変わらない', () => {
    // §6.1 世代横断 2 が求めるのは「小節・拍が保存される」こと。
    // ティックが同じでも、拍子が違えば小節位置は動く
    const seconds = 41;
    const clock = createMusicClock(arrangementFor('FC'));
    clock.start(0);
    const bar = clock.barAt(seconds);
    for (const generation of GENERATION_IDS) {
      clock.rebind(arrangementFor(generation));
      expect(clock.barAt(seconds)).toBeCloseTo(bar, 9);
    }
  });

  it('曲が 1 周する長さが 4 世代で同じ秒数になる', () => {
    const lengths = GENERATION_IDS.map((generation) => {
      const score = arrangementFor(generation);
      return scoreLengthTicks(score) * secondsPerTick(score);
    });
    for (const length of lengths) expect(length).toBeCloseTo(lengths[0]!, 9);
    // 152 BPM の 32 小節 ＝ 約 50 秒
    expect(lengths[0]).toBeGreaterThan(45);
    expect(lengths[0]).toBeLessThan(55);
  });
});

describe('編曲の中身', () => {
  it('4 編曲が同じ和声進行の上に立っている', () => {
    // ベースの根音列が一致すること ＝ 「同じ曲」であることの機械的な担保。
    // パートの数が違っても、コード進行が違えば別の曲になってしまう
    const roots = GENERATION_IDS.map((generation) => {
      const bass = arrangementFor(generation).tracks.find((track) => track.role === 'bass')!;
      // 小節頭の音だけを見る（オクターブ往復の裏拍は除く）
      return bass.notes.filter((note) => note.tick % TICKS_PER_BAR === 0).map((note) => note.pitch);
    });
    expect(roots[0]).toHaveLength(BARS);
    for (const generation of roots.slice(1)) expect(generation).toEqual(roots[0]);
  });

  it('4 編曲が同じ主旋律を持つ', () => {
    const melodies = GENERATION_IDS.map((generation) => {
      const lead = arrangementFor(generation).tracks.find((track) => track.role === 'lead')!;
      return lead.notes.map((note) => [note.tick, note.pitch, note.durationTicks]);
    });
    for (const melody of melodies.slice(1)) expect(melody).toEqual(melodies[0]);
  });

  it('世代が進むほどパートが増える', () => {
    const counts = GENERATION_IDS.map((generation) => arrangementFor(generation).tracks.length);
    for (let index = 1; index < counts.length; index++) {
      expect(counts[index], `${GENERATION_IDS[index]} のパート数`).toBeGreaterThan(
        counts[index - 1]!,
      );
    }
  });

  it('同時発音数が声数の契約を守り、効果音のぶんを空けている', () => {
    for (const generation of GENERATION_IDS) {
      const channels = HARDWARE_GENERATION_PROFILES[generation].audio.channels;
      const peak = maxSimultaneousVoices(arrangementFor(generation));
      expect(peak, `${generation} が ${channels} 声を超えている`).toBeLessThanOrEqual(channels);
      // エンジン音と効果音のぶん。埋め尽くすと鳴らすたびに BGM のパートが消える
      expect(channels - peak, `${generation} に効果音の空きが無い`).toBeGreaterThanOrEqual(1);
    }
  });

  it('第1世代は同じ役割のトラックを 2 本持たない', () => {
    // 第1世代の音源は役割をチャンネルへ 1 対 1 で割り当てる
    // （lead → 矩形波 1・pad → 矩形波 2・bass → 三角波・perc → ノイズ・fx → PCM）。
    // 同じ役割の 2 本目は同じチャンネルを奪い合い、片方が消える
    const roles = rolesOf(ARRANGEMENTS.FC);
    expect(new Set(roles).size).toBe(roles.length);
    // 効果音とエンジン音が使う 2 つの役割は空けておく
    expect(roles).not.toContain('fx');
    expect(roles).not.toContain('pad');
  });

  it('全ての音が定義域に収まっている', () => {
    for (const generation of GENERATION_IDS) {
      for (const track of arrangementFor(generation).tracks) {
        for (const note of track.notes) {
          expect(note.tick).toBeGreaterThanOrEqual(0);
          expect(note.durationTicks).toBeGreaterThan(0);
          expect(note.velocity).toBeGreaterThan(0);
          expect(note.velocity).toBeLessThanOrEqual(1);
          // MIDI の常識的な範囲。外れると音源側で周波数が破綻する
          expect(note.pitch).toBeGreaterThan(20);
          expect(note.pitch).toBeLessThan(108);
        }
      }
    }
  });
});
