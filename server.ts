import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createExpressApp } from './serverApp';

async function startServer() {
  const app = createExpressApp();
  const PORT = 3000;

  // Vite middleware setup in development / static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FerroPátio] CCO Railway Engine online on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('[FerroPátio] Fatal error booting server:', err);
});
