import type { VisemeKey } from '../types';
import { EN_VOWEL_MAP } from './visemeMaps';

/**
 * 文字が ASCII 英字かどうか判定する
 */
export const isAsciiAlpha = (char: string): boolean =>
  /^[A-Za-z]$/.test(char);

/**
 * 英語1文字を Viseme に変換する
 * 母音(a/e/i/o/u/y) → 対応 Viseme
 * 子音              → neutral
 * 非英字           → neutral
 */
export const enCharToViseme = (char: string): VisemeKey =>
  EN_VOWEL_MAP[char] ?? 'neutral';

/**
 * 英語テキストを Viseme シーケンスに変換する
 */
export const enTextToVisemes = (text: string): VisemeKey[] =>
  text.split('').map(enCharToViseme);
