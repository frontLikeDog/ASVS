import type { StudioServices } from '@asvs/ports';
import { delay } from './delay';
import { newId, nowIso } from './id';
import { createVideoPlan, interpretDirectorCommand } from './director-service';
import {
  acceptSuggestion,
  rejectSuggestion,
  reverifyClaim,
  syncKnowledge,
} from './knowledge-service';
import { generateProjectKnowledge, simulateConnection } from './onboarding-service';
import { buildReviewBundle } from './review-service';
import { createExportRecord, tickExportRecord } from './export-service';
import {
  approveProductionRun,
  cancelProductionRun,
  createProductionRun,
  pauseProductionRun,
  resumeProductionRun,
  retryProductionRun,
  setProductionSpeed,
  tickProductionRun,
} from './production-engine';

/**
 * Deterministic adapter used by the browser today. It implements the same
 * `StudioServices` contract a real API-backed adapter will implement, so the
 * store never imports a concrete mock function.
 */
export const mockStudioServices: StudioServices = {
  knowledge: {
    syncKnowledge,
    acceptSuggestion,
    rejectSuggestion,
    reverifyClaim,
  },
  onboarding: {
    simulateConnection,
    generateProjectKnowledge,
  },
  demo: {
    createProductionRun,
    tickProductionRun,
    pauseProductionRun,
    resumeProductionRun,
    cancelProductionRun,
    retryProductionRun,
    approveProductionRun,
    setProductionSpeed,
  },
  evidence: {
    buildReviewBundle,
  },
  director: {
    createVideoPlan,
    interpretDirectorCommand,
  },
  export: {
    createExportRecord,
    tickExportRecord,
  },
  clock: {
    newId,
    nowIso,
    delay,
  },
};

export function createMockStudioServices(): StudioServices {
  return mockStudioServices;
}
