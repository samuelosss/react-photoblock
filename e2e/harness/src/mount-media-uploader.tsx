import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaUploaderHarness } from './MediaUploaderHarness';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MediaUploaderHarness />
  </StrictMode>,
);
