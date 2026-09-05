// WU6.1 — application shell: left rail navigation (Providers · Models ·
// Orchestration · Status) over the utility-console token theme, restyled to
// the light indigo tokens in orchestration-v2 WU-C (bundled rail icons +
// pill-shaped active item, TH-3/TH-5). The rail is chrome only; each
// section owns its data. Providers shipped with WU6, Models with WU7,
// Orchestration with WU8 and Status with WU10 — all four sections are real
// views now, so the placeholder panel is gone.
import { useState } from 'react';
import type { ReactNode } from 'react';

import { IconCube, IconList, IconPlug, IconPulse } from './icons';
import ModelsView from './views/ModelsView';
import OrchestrationView from './views/OrchestrationView';
import ProvidersView from './views/ProvidersView';
import StatusView from './views/StatusView';

const SECTIONS = [
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'orchestration', label: 'Orchestration' },
  { id: 'status', label: 'Status' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/** One bundled glyph per section (aria-hidden; the label names the button). */
const RAIL_ICONS: Record<SectionId, ReactNode> = {
  providers: <IconPlug />,
  models: <IconCube />,
  orchestration: <IconList />,
  status: <IconPulse />,
};

export default function App() {
  const [section, setSection] = useState<SectionId>('providers');
  return (
    <div className="shell">
      <nav className="rail" aria-label="Dashboard sections">
        <div className="rail-brand">
          Model<span>Dashboard</span>
        </div>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="rail-item"
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => setSection(item.id)}
          >
            {RAIL_ICONS[item.id]}
            {item.label}
          </button>
        ))}
        <div className="rail-foot muted">
          local · single-user · no telemetry
        </div>
      </nav>
      <main className="content">
        {section === 'providers' && <ProvidersView />}
        {section === 'models' && <ModelsView />}
        {section === 'orchestration' && <OrchestrationView />}
        {section === 'status' && <StatusView />}
      </main>
    </div>
  );
}
