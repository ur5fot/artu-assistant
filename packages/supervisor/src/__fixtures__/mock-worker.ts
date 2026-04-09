// Simulates a worker that starts and sends ready
process.send?.({ type: 'ready' });

// Keep alive until killed
const interval = setInterval(() => {}, 60000);
process.on('SIGTERM', () => {
  clearInterval(interval);
  process.exit(0);
});
