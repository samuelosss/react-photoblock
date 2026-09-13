import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CropEditorHarness } from './CropEditorHarness';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CropEditorHarness />
  </StrictMode>,
);
