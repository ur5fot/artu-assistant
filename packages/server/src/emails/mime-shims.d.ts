// Ambient type shims for MIME helpers that ship without TypeScript types.
// These are transitive deps via imapflow; declared here so we can import them
// without per-line @ts-expect-error noise (which would silently break if
// upstream ever ships .d.ts files).
declare module 'libqp';
declare module 'libmime';
declare module 'libbase64';
