import type { ApiError } from './client.js';

/**
 * What the DRIVER reads when a request fails.
 *
 * The API's messages are written for developers: a validation failure says
 * "Request validation failed", which is what the device test showed on the
 * Book screen. The code and details are kept for diagnosis; only the message
 * is rewritten, and only where the API's own wording is not for drivers.
 */

/** Fields a driver types, and what to tell them when one is rejected. */
const FIELD_MESSAGES: Record<string, string> = {
  vehiclePlate: 'Check the plate number: up to 32 letters, digits and dashes.',
  phone: 'Enter your phone number with the country code, for example +251911234567.',
  code: 'Enter the 6-digit code from the SMS.',
};

/**
 * Anything else was built by the app, not typed by the driver, so there is
 * nothing for them to correct — only to retry, or update an out-of-date app.
 */
export const VALIDATION_FALLBACK =
  'The app sent something the server could not accept. Try again, and if it keeps happening, update the app.';

function issuePaths(details: unknown): string[] {
  if (typeof details !== 'object' || details === null || !('issues' in details)) return [];
  const { issues } = details;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) =>
    typeof issue === 'object' && issue !== null && 'path' in issue && typeof issue.path === 'string'
      ? [issue.path]
      : [],
  );
}

export function forDriver(error: ApiError): ApiError {
  if (error.code !== 'VALIDATION_ERROR') return error;
  // The first rejected field the driver can do something about.
  const fieldMessage = issuePaths(error.details)
    .map((path) => FIELD_MESSAGES[path])
    .find((message) => message !== undefined);
  return { ...error, message: fieldMessage ?? VALIDATION_FALLBACK };
}
