// Parses an RFC 5322 mailbox of the form `Name <addr@host>` or a bare
// `addr@host` into just the address part. The bare form is the canonical key
// used across modules — sent-log `to_addr`, suppression-rule sender patterns,
// reply envelope — so the display name never leaks into match logic.
//
// Pick the LAST angle-bracketed group: an attacker-controlled display name
// can contain `<fake@evil.com>` (e.g. `"Bank <fake@evil.com>" <real@bank.com>`)
// and matching the first group would route logic to the spoof address.
export function parseFromAddress(fromAddr: string): string {
  const matches = fromAddr.match(/<([^>]+)>/g);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1]!;
    return last.slice(1, -1).trim();
  }
  return fromAddr.trim();
}
