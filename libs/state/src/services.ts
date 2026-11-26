import type { StudioServices } from '@asvs/ports';
import { mockStudioServices } from '@asvs/mock-services';

/**
 * Composition point for everything the studio store uses. The app can swap in
 * an API-backed implementation; unit tests can inject fakes. Defaults to the
 * deterministic mock adapter so an unconfigured browser still works offline.
 */
let current: StudioServices = mockStudioServices;

export function getStudioServices(): StudioServices {
  return current;
}

export function configureStudioServices(next: StudioServices): void {
  current = next;
}

export function resetStudioServices(): void {
  current = mockStudioServices;
}
