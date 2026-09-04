// WU6 (CX-2 / PC-2) — the apiKey presence indicator. It consumes only the
// masked {configured} shape from the API and renders text presence states;
// it never echoes values, and it stays defensive if a malformed payload
// leaked a raw string where a mask belongs (a string is not {configured:true}
// → "Not set"; nothing from the field is rendered).
import { isRecord } from '../api';

export function PresenceBadge({ apiKey }: { apiKey: unknown }) {
  const configured = isRecord(apiKey) && apiKey.configured === true;
  return (
    <span className={configured ? 'badge badge-set' : 'badge badge-none'}>
      {configured ? 'Configured — hidden' : 'Not set'}
    </span>
  );
}
