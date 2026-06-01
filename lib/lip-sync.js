// lip-sync.js — テキスト駆動の口パク（viseme）コア（フレームワーク非依存・素JS）
// 設計: .tmp/design.md §3
//
// /src/lipsync/*.ts を素JSへ移植。store依存を除去し、setInterval ではなく dt 駆動にした
// （ゲームループ統合のため。一時停止・フレーム整合・タイマードリフト回避）。
//
// 使い方:
//   const lip = createLipSync(vrm);
//   lip.play('こんにちは', 8);          // 文字/秒
//   // 毎フレーム（ミリ秒）:
//   lip.update(dtMs);                    // viseme を expressionManager へ適用
//
// viseme（口の母音）プリセットを持たない VRM では口パクをスキップする（表情のみ機能）。

export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

const LIPSYNC_LERP = 0.3;   // viseme を目標へ寄せる補間係数（毎フレーム）

// 日本語（ひらがな・カタカナ）→ Viseme マッピング（visemeMaps.ts 移植）
const JP_VISEME_MAP = {
  'あ': 'aa', 'ア': 'aa', 'い': 'ih', 'イ': 'ih', 'う': 'ou', 'ウ': 'ou', 'え': 'ee', 'エ': 'ee', 'お': 'oh', 'オ': 'oh',
  'か': 'aa', 'カ': 'aa', 'き': 'ih', 'キ': 'ih', 'く': 'ou', 'ク': 'ou', 'け': 'ee', 'ケ': 'ee', 'こ': 'oh', 'コ': 'oh',
  'さ': 'aa', 'サ': 'aa', 'し': 'ih', 'シ': 'ih', 'す': 'ou', 'ス': 'ou', 'せ': 'ee', 'セ': 'ee', 'そ': 'oh', 'ソ': 'oh',
  'た': 'aa', 'タ': 'aa', 'ち': 'ih', 'チ': 'ih', 'つ': 'ou', 'ツ': 'ou', 'て': 'ee', 'テ': 'ee', 'と': 'oh', 'ト': 'oh',
  'な': 'aa', 'ナ': 'aa', 'に': 'ih', 'ニ': 'ih', 'ぬ': 'ou', 'ヌ': 'ou', 'ね': 'ee', 'ネ': 'ee', 'の': 'oh', 'ノ': 'oh',
  'は': 'aa', 'ハ': 'aa', 'ひ': 'ih', 'ヒ': 'ih', 'ふ': 'ou', 'フ': 'ou', 'へ': 'ee', 'ヘ': 'ee', 'ほ': 'oh', 'ホ': 'oh',
  'ま': 'aa', 'マ': 'aa', 'み': 'ih', 'ミ': 'ih', 'む': 'ou', 'ム': 'ou', 'め': 'ee', 'メ': 'ee', 'も': 'oh', 'モ': 'oh',
  'や': 'aa', 'ヤ': 'aa', 'ゆ': 'ou', 'ユ': 'ou', 'よ': 'oh', 'ヨ': 'oh',
  'ら': 'aa', 'ラ': 'aa', 'り': 'ih', 'リ': 'ih', 'る': 'ou', 'ル': 'ou', 'れ': 'ee', 'レ': 'ee', 'ろ': 'oh', 'ロ': 'oh',
  'わ': 'aa', 'ワ': 'aa', 'を': 'oh', 'ヲ': 'oh',
  'が': 'aa', 'ガ': 'aa', 'ぎ': 'ih', 'ギ': 'ih', 'ぐ': 'ou', 'グ': 'ou', 'げ': 'ee', 'ゲ': 'ee', 'ご': 'oh', 'ゴ': 'oh',
  'ざ': 'aa', 'ザ': 'aa', 'じ': 'ih', 'ジ': 'ih', 'ず': 'ou', 'ズ': 'ou', 'ぜ': 'ee', 'ゼ': 'ee', 'ぞ': 'oh', 'ゾ': 'oh',
  'だ': 'aa', 'ダ': 'aa', 'ぢ': 'ih', 'ヂ': 'ih', 'づ': 'ou', 'ヅ': 'ou', 'で': 'ee', 'デ': 'ee', 'ど': 'oh', 'ド': 'oh',
  'ば': 'aa', 'バ': 'aa', 'び': 'ih', 'ビ': 'ih', 'ぶ': 'ou', 'ブ': 'ou', 'べ': 'ee', 'ベ': 'ee', 'ぼ': 'oh', 'ボ': 'oh',
  'ぱ': 'aa', 'パ': 'aa', 'ぴ': 'ih', 'ピ': 'ih', 'ぷ': 'ou', 'プ': 'ou', 'ぺ': 'ee', 'ペ': 'ee', 'ぽ': 'oh', 'ポ': 'oh',
  'ん': 'neutral', 'ン': 'neutral', 'っ': 'neutral', 'ッ': 'neutral', 'ー': 'neutral',
  'ぁ': 'aa', 'ァ': 'aa', 'ぃ': 'ih', 'ィ': 'ih', 'ぅ': 'ou', 'ゥ': 'ou', 'ぇ': 'ee', 'ェ': 'ee', 'ぉ': 'oh', 'ォ': 'oh',
  'ゃ': 'aa', 'ャ': 'aa', 'ゅ': 'ou', 'ュ': 'ou', 'ょ': 'oh', 'ョ': 'oh',
};

// 英語母音文字 → Viseme マッピング
const EN_VOWEL_MAP = {
  'a': 'aa', 'A': 'aa', 'e': 'ee', 'E': 'ee', 'i': 'ih', 'I': 'ih', 'o': 'oh', 'O': 'oh', 'u': 'ou', 'U': 'ou', 'y': 'ih', 'Y': 'ih',
};

function isJapanese(ch) {
  const code = ch.charCodeAt(0);
  return (code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff);
}

// 1文字を viseme（aa/ih/ou/ee/oh/neutral）へ変換。未対応文字は neutral。
export function charToViseme(ch) {
  if (!ch) return 'neutral';
  if (isJapanese(ch)) return JP_VISEME_MAP[ch] ?? 'neutral';
  if (/^[A-Za-z]$/.test(ch)) return EN_VOWEL_MAP[ch] ?? 'neutral';
  return 'neutral';
}

export function createLipSync(vrm) {
  let chars = [];
  let idx = 0;
  let acc = 0;             // 文字送りの経過時間（ms）
  let interval = 1000 / 8; // 1文字あたりのms
  let playing = false;
  let target = 'neutral';

  return {
    get playing() { return playing; },

    // text を 1文字ずつ送る発話を開始。cps = 文字/秒。
    play(text, cps = 8) {
      chars = [...(text || '')];
      idx = 0;
      acc = 0;
      interval = 1000 / Math.max(1, cps);
      playing = chars.length > 0;
      target = 'neutral';
    },

    // 発話中断（口は update 側で neutral=0 へ LERP）
    stop() {
      playing = false;
      target = 'neutral';
    },

    // 毎フレーム呼ぶ（dtMs = 経過ミリ秒）。文字送り＋viseme の平滑化を行う。
    update(dtMs) {
      if (playing) {
        acc += dtMs;
        while (acc >= interval && idx < chars.length) {
          target = charToViseme(chars[idx]);
          idx++;
          acc -= interval;
        }
        if (idx >= chars.length) playing = false;   // 送り完了（口は閉じへ向かう）
      }
      const em = vrm && vrm.expressionManager;
      if (!em) return;
      for (const v of VISEMES) {
        const t = (playing && v === target) ? 1 : 0;
        const cur = em.getValue(v) ?? 0;
        const next = cur + (t - cur) * LIPSYNC_LERP;
        try { em.setValue(v, next); } catch { /* viseme 未定義の VRM は無視 */ }
      }
    },
  };
}
