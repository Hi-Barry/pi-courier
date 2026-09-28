import { afterEach, describe, expect, it } from 'vitest';
import { detectSystemLanguage, parseLocaleValue } from '../src/i18n/detect';
import { getLocale, setLocale, t } from '../src/i18n/index';
import { isCancelInput } from '../src/i18n/parse';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';
import { resolveLanguage } from '../src/config';

describe('i18n tables', () => {
  it('en table is key-aligned with the zh baseline (runtime pin; typecheck already enforces)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('zh baseline keeps historical copy verbatim (migration = verbatim into table)', () => {
    expect(zh['cmd.new.ok']).toBe('✅ 已开始新会话');
    expect(zh['common.cancel']).toBe('取消');
  });
});

describe('t()', () => {
  afterEach(() => setLocale('zh'));

  it('follows the active locale', () => {
    setLocale('zh');
    expect(t('cmd.new.ok')).toBe('✅ 已开始新会话');
    setLocale('en');
    expect(t('cmd.new.ok')).toBe('✅ New session started');
  });

  it('interpolates {name} placeholders', () => {
    setLocale('en');
    expect(t('cmd.generic.error', { message: 'boom' })).toBe('❌ Command failed: boom');
  });

  it('leaves an unknown placeholder as-is (fail-visible)', () => {
    setLocale('en');
    expect(t('cmd.generic.error', { other: 'x' })).toBe('❌ Command failed: {message}');
  });
});

describe('parseLocaleValue', () => {
  it('maps zh family (all scripts/regions) to zh', () => {
    expect(parseLocaleValue('zh_CN.UTF-8')).toBe('zh');
    expect(parseLocaleValue('zh_TW')).toBe('zh');
    expect(parseLocaleValue('zh-Hans')).toBe('zh');
    expect(parseLocaleValue('zh')).toBe('zh');
  });

  it('maps other resolvable locales to en', () => {
    expect(parseLocaleValue('en_US.UTF-8')).toBe('en');
    expect(parseLocaleValue('fr_FR.UTF-8')).toBe('en');
  });

  it('returns null for no-information values', () => {
    expect(parseLocaleValue(undefined)).toBeNull();
    expect(parseLocaleValue('')).toBeNull();
    expect(parseLocaleValue('C')).toBeNull();
    expect(parseLocaleValue('POSIX')).toBeNull();
    expect(parseLocaleValue('  ')).toBeNull();
  });
});

describe('detectSystemLanguage', () => {
  it('respects POSIX precedence LC_ALL > LC_MESSAGES > LANG', () => {
    expect(detectSystemLanguage({ LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN', LANG: 'zh_CN' })).toBe('en');
    expect(detectSystemLanguage({ LC_MESSAGES: 'zh_CN', LANG: 'en_US' })).toBe('zh');
    expect(detectSystemLanguage({ LANG: 'zh_CN.UTF-8' })).toBe('zh');
  });

  it('skips no-information values and falls back down the chain', () => {
    expect(detectSystemLanguage({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' })).toBe('zh');
    expect(detectSystemLanguage({ LC_ALL: 'C', LC_MESSAGES: 'C', LANG: 'C' })).toBeNull();
    expect(detectSystemLanguage({})).toBeNull();
  });
});

describe('resolveLanguage chain (env > config > system > en)', () => {
  it('PI_LANGUAGE wins (env)', () => {
    expect(resolveLanguage({ language: 'zh' }, { PI_LANGUAGE: 'en' })).toEqual({ locale: 'en', source: 'env' });
    expect(resolveLanguage({}, { PI_LANGUAGE: 'ZH' })).toEqual({ locale: 'zh', source: 'env' });
    expect(resolveLanguage({}, { PI_LANGUAGE: 'fr' })).toEqual({ locale: 'en', source: 'default' });
  });

  it('config language is second', () => {
    expect(resolveLanguage({ language: 'zh' }, {})).toEqual({ locale: 'zh', source: 'config' });
  });

  it('system locale is third', () => {
    expect(resolveLanguage({}, { LANG: 'zh_CN.UTF-8' })).toEqual({ locale: 'zh', source: 'system' });
  });

  it('default is en with source "default"', () => {
    expect(resolveLanguage({}, {})).toEqual({ locale: 'en', source: 'default' });
  });
});

describe('isCancelInput (cancel protocol, issue #83)', () => {
  it('accepts both spellings in every locale', () => {
    expect(isCancelInput('取消')).toBe(true);
    expect(isCancelInput('  取消  ')).toBe(true);
    expect(isCancelInput('cancel')).toBe(true);
    expect(isCancelInput('Cancel')).toBe(true);
    expect(isCancelInput('CANCEL')).toBe(true);
  });

  it('rejects non-cancel text', () => {
    expect(isCancelInput('取 消')).toBe(false);
    expect(isCancelInput('cancels')).toBe(false);
    expect(isCancelInput('')).toBe(false);
    expect(isCancelInput('是')).toBe(false);
  });
});

describe('getLocale', () => {
  afterEach(() => setLocale('zh'));

  it('reflects setLocale', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    setLocale('zh');
    expect(getLocale()).toBe('zh');
  });
});
