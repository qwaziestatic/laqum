import { describe, expect, it } from 'vitest';
import { socketOriginFor } from '../src/realtime/connection.js';

/**
 * The socket lives at the API's origin (Socket.io's /socket.io path), while
 * EXPO_PUBLIC_API_URL is the REST base, ending in /v1. Derived with a plain
 * string rule: React Native's URL implementation is incomplete.
 */
describe('the socket address, from the API URL', () => {
  it('drops the /v1 of the device-test LAN address', () => {
    expect(socketOriginFor('http://192.168.1.20:18000/v1')).toBe('http://192.168.1.20:18000');
  });

  it('drops a trailing slash too', () => {
    expect(socketOriginFor('https://api.laqum.example/v1/')).toBe('https://api.laqum.example');
    expect(socketOriginFor('http://localhost:3000/')).toBe('http://localhost:3000');
  });

  it('leaves a URL without /v1 as it is', () => {
    expect(socketOriginFor('http://localhost:3000')).toBe('http://localhost:3000');
  });
});
