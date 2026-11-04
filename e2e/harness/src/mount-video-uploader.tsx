import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VideoUploaderHarness } from './VideoUploaderHarness';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <VideoUploaderHarness />
  </StrictMode>,
);
