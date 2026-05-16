import { describe, it, expect } from 'vitest';
import { isJapanese, jpCharToViseme, jpTextToVisemes } from './JapaneseLipSync';
import { isAsciiAlpha, enCharToViseme, enTextToVisemes } from './EnglishLipSync';

// ---- JapaneseLipSync ----
describe('isJapanese', () => {
  it('ひらがなを日本語と判定する', () => {
    expect(isJapanese('あ')).toBe(true);
    expect(isJapanese('ん')).toBe(true);
  });
  it('カタカナを日本語と判定する', () => {
    expect(isJapanese('ア')).toBe(true);
    expect(isJapanese('ン')).toBe(true);
  });
  it('ASCII 英字を日本語と判定しない', () => {
    expect(isJapanese('a')).toBe(false);
    expect(isJapanese('Z')).toBe(false);
  });
  it('数字・記号を日本語と判定しない', () => {
    expect(isJapanese('1')).toBe(false);
    expect(isJapanese('！')).toBe(false);
  });
});

describe('jpCharToViseme', () => {
  it('あ行が正しく変換される', () => {
    expect(jpCharToViseme('あ')).toBe('aa');
    expect(jpCharToViseme('い')).toBe('ih');
    expect(jpCharToViseme('う')).toBe('ou');
    expect(jpCharToViseme('え')).toBe('ee');
    expect(jpCharToViseme('お')).toBe('oh');
  });
  it('か行が正しく変換される', () => {
    expect(jpCharToViseme('か')).toBe('aa');
    expect(jpCharToViseme('き')).toBe('ih');
    expect(jpCharToViseme('く')).toBe('ou');
    expect(jpCharToViseme('け')).toBe('ee');
    expect(jpCharToViseme('こ')).toBe('oh');
  });
  it('カタカナが正しく変換される', () => {
    expect(jpCharToViseme('ア')).toBe('aa');
    expect(jpCharToViseme('イ')).toBe('ih');
    expect(jpCharToViseme('ウ')).toBe('ou');
    expect(jpCharToViseme('エ')).toBe('ee');
    expect(jpCharToViseme('オ')).toBe('oh');
  });
  it('撥音・促音が neutral になる', () => {
    expect(jpCharToViseme('ん')).toBe('neutral');
    expect(jpCharToViseme('ン')).toBe('neutral');
    expect(jpCharToViseme('っ')).toBe('neutral');
    expect(jpCharToViseme('ッ')).toBe('neutral');
  });
  it('マッピングにない文字が neutral になる', () => {
    expect(jpCharToViseme('！')).toBe('neutral');
    expect(jpCharToViseme('1')).toBe('neutral');
    expect(jpCharToViseme('a')).toBe('neutral');
  });
});

describe('jpTextToVisemes', () => {
  it('"こんにちは" が正しく変換される', () => {
    expect(jpTextToVisemes('こんにちは')).toEqual(['oh', 'neutral', 'ih', 'ih', 'aa']);
  });
  it('"アイウエオ" が正しく変換される', () => {
    expect(jpTextToVisemes('アイウエオ')).toEqual(['aa', 'ih', 'ou', 'ee', 'oh']);
  });
  it('"まっか" が正しく変換される（促音）', () => {
    expect(jpTextToVisemes('まっか')).toEqual(['aa', 'neutral', 'aa']);
  });
  it('空文字列は空配列を返す', () => {
    expect(jpTextToVisemes('')).toEqual([]);
  });
});

// ---- EnglishLipSync ----
describe('isAsciiAlpha', () => {
  it('英小文字を ASCII アルファと判定する', () => {
    expect(isAsciiAlpha('a')).toBe(true);
    expect(isAsciiAlpha('z')).toBe(true);
  });
  it('英大文字を ASCII アルファと判定する', () => {
    expect(isAsciiAlpha('A')).toBe(true);
    expect(isAsciiAlpha('Z')).toBe(true);
  });
  it('数字・記号・空白を ASCII アルファと判定しない', () => {
    expect(isAsciiAlpha('1')).toBe(false);
    expect(isAsciiAlpha('!')).toBe(false);
    expect(isAsciiAlpha(' ')).toBe(false);
  });
});

describe('enCharToViseme', () => {
  it('母音が正しく変換される（小文字）', () => {
    expect(enCharToViseme('a')).toBe('aa');
    expect(enCharToViseme('e')).toBe('ee');
    expect(enCharToViseme('i')).toBe('ih');
    expect(enCharToViseme('o')).toBe('oh');
    expect(enCharToViseme('u')).toBe('ou');
  });
  it('母音が正しく変換される（大文字）', () => {
    expect(enCharToViseme('A')).toBe('aa');
    expect(enCharToViseme('E')).toBe('ee');
    expect(enCharToViseme('I')).toBe('ih');
    expect(enCharToViseme('O')).toBe('oh');
    expect(enCharToViseme('U')).toBe('ou');
  });
  it('y/Y が ih になる', () => {
    expect(enCharToViseme('y')).toBe('ih');
    expect(enCharToViseme('Y')).toBe('ih');
  });
  it('子音が neutral になる', () => {
    expect(enCharToViseme('b')).toBe('neutral');
    expect(enCharToViseme('h')).toBe('neutral');
    expect(enCharToViseme('z')).toBe('neutral');
  });
  it('非英字が neutral になる', () => {
    expect(enCharToViseme('1')).toBe('neutral');
    expect(enCharToViseme('!')).toBe('neutral');
    expect(enCharToViseme(' ')).toBe('neutral');
  });
});

describe('enTextToVisemes', () => {
  it('"aeiou" が正しく変換される', () => {
    expect(enTextToVisemes('aeiou')).toEqual(['aa', 'ee', 'ih', 'oh', 'ou']);
  });
  it('"hello" が正しく変換される', () => {
    expect(enTextToVisemes('hello')).toEqual(['neutral', 'ee', 'neutral', 'neutral', 'oh']);
  });
  it('"HELLO" が正しく変換される（大文字）', () => {
    expect(enTextToVisemes('HELLO')).toEqual(['neutral', 'ee', 'neutral', 'neutral', 'oh']);
  });
  it('空文字列は空配列を返す', () => {
    expect(enTextToVisemes('')).toEqual([]);
  });
});
