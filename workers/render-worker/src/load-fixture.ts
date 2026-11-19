import { readFileSync } from 'node:fs';
import type { RenderFixtureV1, RenderInputV1 } from '@asvs/domain';
import { buildRenderInput, renderFixtureV1Schema } from '@asvs/domain';

export function loadRenderFixture(file: string): {
  fixture: RenderFixtureV1;
  input: RenderInputV1;
} {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const fixture = renderFixtureV1Schema.parse(raw);
  const input = buildRenderInput({
    video: fixture.video,
    project: fixture.project,
    features: fixture.features,
    assets: fixture.assets,
  });
  return { fixture, input };
}
