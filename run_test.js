const { execSync } = require('child_process');
try {
  execSync('cd backend && npx vitest run src/routes/oidc.insecurefetch.test.ts', { stdio: 'inherit' });
} catch (e) {
  console.log('Error:', e.message);
}
