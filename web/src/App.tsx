// WU6.1 — application shell: left rail navigation (Providers · Models ·
// Orchestration · Status) over the utility-console token theme. The rail is
// chrome only; each section owns its data. Providers ships with WU6, Models
// with WU7, Orchestration with WU8; the remaining section arrives with its
// own work unit (WU10) and renders a plain "not yet available" panel until
// then.
import { useState } from 'react';

import ModelsView from './views/ModelsView';
import OrchestrationView from './views/OrchestrationView';
import ProvidersView from './views/ProvidersView';

const SECTIONS = [
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'orchestration', label: 'Orchestration' },
  { id: 'status', label: 'Status' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="panel">
      <h2>{label}</h2>
      <p className="muted">This section is not available yet.</p>
    </div>
  );
}

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
        {section === 'status' && <ComingSoon label="Status" />}
      </main>
    </div>
  );
}
