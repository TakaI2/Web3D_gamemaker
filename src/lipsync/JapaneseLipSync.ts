import type { VisemeKey } from '../types';
import { JP_VISEME_MAP } from './visemeMaps';

/**
 * 文字がひらがな or カタカナかどうか判定する
 */
export const isJapanese = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x3040 && code <= 0x309f) || // ひらがな
    (code >= 0x30a0 && code <= 0x30ff)    // カタカナ
  );
};

/**
 * 日本語1文字を Viseme に変換する
 * マッピングにない文字（記号・数字等）は neutral を返す
 */
export const jpCharToViseme = (char: string): VisemeKey =>
  JP_VISEME_MAP[char] ?? 'neutral';

/**
 * 日本語テキストを Viseme シーケンスに変換する
 */
export const jpTextToVisemes = (text: string): VisemeKey[] =>
  text.split('').map(jpCharToViseme);
