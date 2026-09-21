import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const VALID = {
  DATABASE_URL: 'postgres://laqum:laqum@localhost:5432/laqum',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('applies defaults for everything optional', () => {
    const config = loadConfig(VALID);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from the string the environment always provides', () => {
    expect(loadConfig({ ...VALID, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a PORT that is not a usable port', () => {
    expect(() => loadConfig({ ...VALID, PORT: '0' })).toThrow(/PORT/u);
    expect(() => loadConfig({ ...VALID, PORT: '70000' })).toThrow(/PORT/u);
    expect(() => loadConfig({ ...VALID, PORT: 'http' })).toThrow(/PORT/u);
  });

  it('names the missing variable rather than failing later at first use', () => {
    expect(() => loadConfig({ REDIS_URL: VALID.REDIS_URL })).toThrow(/DATABASE_URL/u);
    expect(() => loadConfig({ DATABASE_URL: VALID.DATABASE_URL })).toThrow(/REDIS_URL/u);
  });

  it('rejects a connection string pointed at the wrong kind of server', () => {
    // A DATABASE_URL holding a redis:// URL is a copy-paste slip that would
    // otherwise surface as an opaque connection error.
    expect(() => loadConfig({ ...VALID, DATABASE_URL: 'redis://localhost:6379' })).toThrow(
      /postgres/u,
    );
    expect(() => loadConfig({ ...VALID, REDIS_URL: 'postgres://localhost:5432/x' })).toThrow(
      /redis/u,
    );
  });

  it('accepts both accepted spellings of the postgres scheme', () => {
    expect(loadConfig({ ...VALID, DATABASE_URL: 'postgresql://a@b/c' }).DATABASE_URL).toBe(
      'postgresql://a@b/c',
    );
  });

  it('rejects an unknown NODE_ENV rather than silently treating it as production', () => {
    expect(() => loadConfig({ ...VALID, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/u);
  });
});
