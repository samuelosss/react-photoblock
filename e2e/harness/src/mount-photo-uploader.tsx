import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PhotoUploaderHarness } from './PhotoUploaderHarness';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PhotoUploaderHarness />
  </StrictMode>,
);
